# AdGuard Protection Watch: Plan

## Goal

Kevin turns off AdGuard DNS protection and forgets to turn it back on. After protection has been off for an hour, a Cloudflare Worker sends a reminder through the Grok bot. If Kevin doesn't answer, the Worker turns protection back on itself.

## Fail-safe rule

**If anything goes wrong, protection ends up on.** The Worker should never be the reason protection stays off. Whenever it's unsure, it turns protection on.

| Failure | What happens |
|---|---|
| A reminder webhook fails (bot down, URL changed) | It still counts as sent, and protection is turned on at the next check. |
| KV read or write fails while protection is off | Protection is turned on. |
| Any unexpected error in the check while protection is off | Protection is turned on. |
| A setting is missing or invalid (`REMIND_AFTER_MIN`, etc.) | The default is used (60 / 5 / 60). |
| A snooze request is invalid (bad code, bad minutes) | It's rejected. The reminder still stands, so protection is turned on on schedule. |
| The bot misreads a reply | Nothing is snoozed, so protection is turned on on schedule. |
| The AdGuard API itself is down | Out of scope. The Worker logs the error and tries again at the next check. |

## How it behaves

1. Kevin turns protection off with one of the **switches the Worker watches**:
   - **A device toggle** (the usual case, e.g. just "Kevin's MacBook Pro"): `GET/PUT /devices/{id}/settings` → `protection_enabled`.
   - **The server toggle**: the "Protection is enabled/disabled" switch under "Kevin's AdGuard Server". It covers all devices: `GET/PUT /dns_servers/{id}/settings` → `protection_enabled`.
   - **Not the account-wide toggle at the top of Home.** The public API can't see or change that one, so the Worker would never notice it.
2. A Worker cron checks every 5 minutes. It reads the server and every device; devices are listed fresh each time, so new devices are covered automatically. **One shared timer:** the switch counts as "off" if any switch is off. The first check that finds anything off records `off_since`. The timer keeps running until *every* switch is back on, even if the off switches change in between.
3. Once something has been off for `REMIND_AFTER_MIN` (60), the Worker sends a **reminder** webhook to the Grok bot listing what's off (e.g. "Kevin's MacBook Pro"). Kevin can reply:
   - **"turn on"**: the bot turns on every switch in the reminder's `off` list directly through the AdGuard API (its existing `adguard-dns` access). The Worker sees everything on at the next check and clears its state.
   - **"snooze"**: no reminders for 1 hour. "snooze 20m" or "snooze 3h" picks the length. There's no limit on how long a snooze lasts or how many times in a row Kevin snoozes. When the snooze ends, the next check sends a new reminder.
   - **"snooze"** covers everything that's off, including a switch turned off during the snooze.
4. If there's no reply within `AUTO_ENABLE_AFTER_MIN` (5) of a reminder, the Worker turns on **every switch that's off at that moment** and sends an **auto_enabled** webhook listing them.
5. When a check finds every switch on, whether Kevin turned them on, the bot did, the Worker did, or anyone else did, the stored state is cleared. The next time anything goes off, the cycle starts fresh.

The timing doesn't need to be exact. A 5-minute check means the reminder comes 60 to 65 minutes after protection goes off, and auto turn-on comes about one check after the reminder.

**One shared timer, by design.** Kevin rarely has more than one thing off at once, and one timer is simpler than a timer per switch. The catch: a second device turned off 50 minutes after the first gets only about 10 minutes before the shared reminder. That's acceptable.

## Architecture

```
            every 5 min
Cloudflare cron ───────▶ Worker.scheduled()
                           │  GET v2/dns_servers + v2/devices  (AdGuard API)
                           │  read/write KV "state"
                           │  PUT …/settings on each off switch  (auto turn-on)
                           ▼
                     POST WEBHOOK_URLS ──▶ Grok bot ──▶ Kevin
                                              │           │
                                              │◀──────────┘ "snooze" / "turn on"
                     Worker.fetch() ◀─────────┤ snooze: POST snooze URL
                     AdGuard API    ◀─────────┘ turn on: adguard-dns skill
```

- **Runtime:** a Cloudflare Worker on the free plan, written in TypeScript.
- **State:** one Workers KV key, `state`.
- **AdGuard API:** `https://api.adguard-dns.io/oapi/v1`, with the header `Authorization: ApiKey <key>`.
  - Reading, two calls per check:
    - `GET /oapi/v2/dns_servers`: the server with `ADGUARD_SERVER_ID`, `settings.protection_enabled`.
    - `GET /oapi/v2/devices`: every device with `name` and `settings.protection_enabled` inline, keeping only those on that server.
  - Writing: `PUT /oapi/v1/dns_servers/{id}/settings` or `PUT /oapi/v1/devices/{id}/settings` with `{"protection_enabled": true}`.

## State (KV key `state`)

```ts
type State = {
  off_since: string;           // ISO: first check that saw protection off
  snooze_until?: string;       // ISO: no reminders before this time
  reminded_at?: string;        // ISO: when the current reminder was sent
  snooze_code?: string;        // crypto.randomUUID() for the current reminder's snooze link
};
```

If the key is missing, protection was on at the last check.

The free plan allows **1,000 KV writes a day**, and the cron runs 288 times a day. The Worker therefore writes to KV only when the state changes. A normal day takes a handful of writes.

## Check logic (`scheduled`)

```
switches = [server] + devices on that server      # each: { kind, id, name, enabled }
  on error: log, return (try again next check; the Worker can't do anything without the API)
off = switches where !enabled

if off is empty:
  if state exists: delete it
  return

# From here on something is off. Any error below → turnOn() (fail-safe).
try:
  if no state:
    write { off_since: now }
    return

  if snooze_until and now < snooze_until:
    return

  if reminded_at:
    if now >= reminded_at + AUTO_ENABLE_AFTER_MIN:
      turnOn()
    return

  due = snooze_until ?? off_since + REMIND_AFTER_MIN
  if now >= due:
    code = crypto.randomUUID()
    POST webhooks { event: "reminder", off, ... }   # failures logged, never thrown
    write { ...state, reminded_at: now, snooze_code: code }
catch:
  log, turnOn()

turnOn():
  for each s in off: PUT s protection_enabled=true   # one failing doesn't stop the rest
  POST webhooks { event: "auto_enabled", off, ... }  # best effort
  delete state                                       # best effort; a switch still off restarts the cycle
```

## HTTP endpoints (`fetch`)

The Worker accepts only one action, snooze. Turning protection on goes through the bot's own AdGuard access.

| Method | Path | What it does |
|---|---|---|
| `POST` | `/snooze?code=…&minutes=N` | `N` defaults to 60 and must be a whole number of at least 1, with no upper limit. Sets `snooze_until = now + N` and clears `reminded_at` and `snooze_code`, so the link stops working after one use. Returns `200 {"ok":true,"snooze_until":…}`. |
| `GET` | `/snooze?code=…` | A small HTML page with a minutes box and a "Snooze" button that POSTs to the same URL. **A GET never snoozes**, so link previews and prefetching can't trigger anything. |
| `GET` | `/` | Returns `200 ok` (health check). Shows no state. |

If the code is wrong or missing, the Worker returns `404`. If no reminder is pending, it returns `410 Gone`. Either way nothing changes, so auto turn-on still happens on schedule.

KV takes up to about 60 seconds to sync between regions, so "one-time" is best-effort. That does no harm here.

## Webhook payload

The Worker sends a `POST` to each URL in `WEBHOOK_URLS` (comma-separated) with `Content-Type: application/json`:

```json
{
  "event": "reminder",
  "message": "AdGuard DNS protection is off for Kevin's MacBook Pro (1h). Reply \"snooze\" (or \"snooze 20m\") or \"turn on\". It turns back on automatically in ~5 min.",
  "off_since": "2026-11-04T19:02:00Z",
  "auto_enable_at": "2026-11-04T20:07:00Z",
  "off": [
    { "kind": "device", "id": "<device-id>", "name": "Kevin's MacBook Pro" }
  ],
  "snooze": { "method": "POST", "url": "https://<worker>/snooze?code=…", "params": { "minutes": "integer, default 60" } }
}
```

```json
{
  "event": "auto_enabled",
  "message": "No reply, so AdGuard DNS protection is back on for Kevin's MacBook Pro.",
  "off_since": "2026-11-04T19:02:00Z",
  "off": [
    { "kind": "device", "id": "<device-id>", "name": "Kevin's MacBook Pro" }
  ]
}
```

Messages give relative times ("~5 min") so the Worker needs no time zone setting.

**Grok bot:** the bot needs instructions for these webhooks.
- It forwards `message` to Kevin.
- When Kevin replies "turn on", it uses its `adguard-dns` access to set `protection_enabled=true` on every item in the reminder's `off` list (`kind: "server"` → `/dns_servers/{id}/settings`, `kind: "device"` → `/devices/{id}/settings`).
- When Kevin replies "snooze [duration]", it converts the duration to minutes and POSTs `snooze.url&minutes=N`.
- If it can't tell what Kevin meant, it does nothing and auto turn-on proceeds.

## Configuration

| Name | Kind | Committed? | Value |
|---|---|---|---|
| `REMIND_AFTER_MIN` | var | yes | `60` |
| `AUTO_ENABLE_AFTER_MIN` | var | yes | `5` |
| `DEFAULT_SNOOZE_MIN` | var | yes | `60` |
| `STATE` | KV binding | yes (namespace id) | — |
| cron | trigger | yes | `*/5 * * * *` |
| `ADGUARD_DNS_API_KEY` | secret | **no** | AdGuard API key |
| `ADGUARD_SERVER_ID` | secret | **no** | ID of "Kevin's AdGuard Server" |
| `WEBHOOK_URLS` | secret | **no** | Grok bot webhook URL (anyone holding it can message the bot) |

## Repo

- `kevintraver/adguard-protection-watch`, **public**, in this folder.
- No secrets in git. Secrets are set with `wrangler secret put`, and local dev reads `.dev.vars`, which is gitignored.
- Deploy by running `wrangler deploy` from the Mac. No CI.

```
adguard-protection-watch/
  src/index.ts          # scheduled() + fetch()
  src/adguard.ts        # get/set protection
  src/state.ts          # KV read/write
  test/index.test.ts    # vitest + @cloudflare/vitest-pool-workers
  wrangler.jsonc
  .dev.vars.example
  README.md
```

## Tests

Unit tests use a mocked AdGuard API, a mocked webhook, and a fake clock.

**Normal flow:**
- Protection on with no state: no writes.
- Protection on with state: state deleted.
- Off for the first time: `off_since` written.
- Off for less than 60 minutes: nothing happens.
- Off for 60 minutes or more: reminder sent, `reminded_at` and `snooze_code` written.
- Reminder older than 5 minutes: protection turned on, `auto_enabled` sent, state deleted.
- Snooze with a valid code: `snooze_until` set, code cleared, no reminder until the snooze ends, then the cycle runs again.
- Snooze for a very long time (e.g. 10,000 minutes): accepted.

**Devices:**
- Only a device is off (server on): the timer runs, the reminder names that device, and auto turn-on turns on only that device.
- Server and a device are both off: both are listed, and auto turn-on turns both on.
- A second device goes off partway through: the timer stays at the first `off_since`, and the reminder lists both.
- One device turned back on while another stays off: the timer keeps running.
- Devices on other servers are ignored. A newly added device is picked up without a config change.
- One PUT fails during auto turn-on: the rest still get turned on.

**Fail-safe:**
- Webhook fails: still counts as a reminder sent, and protection is turned on at the next check.
- KV read throws while protection is off: protection turned on.
- KV write throws while protection is off: protection turned on.
- Unexpected exception while protection is off: protection turned on.
- Missing or invalid setting values: defaults used.
- Wrong code returns 404 and no pending reminder returns 410. In both cases state is unchanged and auto turn-on still happens.
- A GET never changes state.
- AdGuard API error: no state change, nothing thrown.

## End-to-end check against the real server

1. Deploy with `REMIND_AFTER_MIN=5` and `AUTO_ENABLE_AFTER_MIN=5`.
2. Turn protection off for **one device** in the dashboard. A reminder naming that device should arrive in the Grok bot within about 10 minutes.
3. Reply "snooze 5m". The next reminder should arrive about 5 minutes after the snooze ends.
4. Ignore it. Protection should come back on within about 5 minutes, with an `auto_enabled` message.
5. Turn protection off again, wait for the reminder, and reply "turn on". The bot should turn protection on, and the next check should clear the state.
6. Temporarily set `WEBHOOK_URLS` to an address that doesn't work, turn protection off, and wait. Protection should come back on with no reminder.
7. Set the timers back to 60 and 5, restore `WEBHOOK_URLS`, and deploy again.

## Verified (2026-11-04)

**The AdGuard API and the two toggles:**
- The public API's `protection_enabled` (`PUT /dns_servers/{id}/settings`) is the **server** toggle. Setting it to `false` stopped filtering after about 10 seconds, setting it to `true` brought filtering back, and the dashboard's server toggle showed each change.
- The **account-wide** "Protection is enabled" toggle at the top of Home also stops filtering, but it changes nothing the public API returns. The server and device `protection_enabled` both stayed `true`. No endpoint in the OpenAPI spec reads or changes it.
- A reliable way to check whether filtering is live: look up a made-up `<random>.site` name. User rule `||*.site^` blocks it, so `0.0.0.0` means on and "doesn't exist" means off.

**The Grok bot (a Cursor Automation webhook, `Authorization: Bearer <key>`):**
- It accepts the webhook and messages Kevin.
- It ignores instructions sent inside a webhook, so the handling rules live in the bot's own saved settings.
- When Kevin replied "snooze for 20 minutes", the bot sent `POST <snooze.url>&minutes=20` to the link from the earlier reminder. So it keeps the reminder's context when a reply comes in.
- When Kevin replied "turn on" to a reminder with `off: [{kind: "device", id: "<device-id>"}]`, the bot set that device's `protection_enabled=true`, told Kevin which device it turned on, and didn't call the snooze link.

**Device toggles:**
- Turning off "Kevin's MacBook Pro" with its dashboard device toggle showed up as `protection_enabled: false` in `GET /oapi/v2/devices`, with the server and other devices still `true`. The canary lookup was not blocked.
- After the bot turned it on, the API showed `true` again and the canary was blocked again.

## Build steps

1. ~~Find out what the Grok bot's webhook expects, and confirm the device toggles.~~ Done (see Verified).
2. Run `git init`, create the public GitHub repo, and scaffold the Worker with `npm create cloudflare`.
3. Write `adguard.ts` and `state.ts`, then `scheduled()`, then `fetch()`, with tests for each.
4. Create the KV namespace, put in the secrets, and deploy.
5. Run the end-to-end check above.
6. Add the webhook handling instructions to the Grok bot.

## Out of scope

- Pausing from chat, or timed pauses ("pause 20 min").
- Separate timers, snoozes or replies per device (one shared timer instead).
- The account-wide Home toggle. The public API can't see it, so Kevin uses the server toggle instead.
- Pushover, ntfy, and email.
- Quiet hours.
- AdGuard API outages: that's AdGuard's problem, not this tool's. The Worker only retries at the next check, and errors go to the Worker logs with no alert.
- CI or automated deploys.
