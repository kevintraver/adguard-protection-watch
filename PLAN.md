# AdGuard Protection Watch: Plan

## Goal

You turn off AdGuard DNS protection to get past something it's blocking, then forget to turn it back on. AdGuard DNS has no "turn off for an hour" option.

AdGuard Protection Watch is a small Cloudflare Worker that notices. Once protection has been off for an hour, it sends a reminder to a chat bot (or any webhook). You can snooze it or turn protection back on. If you don't answer, the Worker turns protection back on by itself.

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

1. You turn protection off with one of the **switches the Worker watches**:
   - **A device toggle** (the usual case, e.g. just your laptop): `GET/PUT /devices/{id}/settings` → `protection_enabled`.
   - **The server toggle**: the "Protection is enabled/disabled" switch under your DNS server on the dashboard Home page. It covers every device on that server: `GET/PUT /dns_servers/{id}/settings` → `protection_enabled`.
   - **Not the account-wide toggle at the top of Home.** The public API can't see or change that one, so the Worker would never notice it. Use a device or server toggle instead.
2. A Worker cron checks every 5 minutes. It reads the server and every device on it. Devices are listed fresh each time, so new devices are covered automatically. **One shared timer:** protection counts as "off" if any switch is off. The first check that finds anything off records `off_since`. The timer keeps running until *every* switch is back on, even if the set of off switches changes in between.
3. Once something has been off for `REMIND_AFTER_MIN` (60), the Worker sends a **reminder** webhook listing what's off (e.g. "MacBook Pro"). You can reply to the bot:
   - **"turn on"**: the bot turns on every switch in the reminder's `off` list, using its own AdGuard API access. The Worker sees everything on at the next check and clears its state.
   - **"snooze"**: no reminders for 1 hour. "snooze 20m" or "snooze 3h" picks the length. There's no limit on how long a snooze lasts or how many times in a row you snooze. A snooze covers everything that's off, including a switch turned off during the snooze. When the snooze ends, the next check sends a new reminder.
4. If there's no reply within `AUTO_ENABLE_AFTER_MIN` (5) of a reminder, the Worker turns on **every switch that's off at that moment** and sends an **auto_enabled** webhook listing them.
5. When a check finds every switch on, whether you turned them on, the bot did, the Worker did, or anyone else did, the stored state is cleared. The next time anything goes off, the cycle starts fresh.

The timing doesn't need to be exact. A 5-minute check means the reminder comes 60 to 65 minutes after protection goes off, and auto turn-on comes about one check after the reminder.

**One shared timer, by design.** It's rare to have more than one thing off at once, and one timer is simpler than a timer per switch. The catch: a second device turned off 50 minutes after the first gets only about 10 minutes before the shared reminder. That's acceptable.

## Architecture

```
            every 5 min
Cloudflare cron ───────▶ Worker.scheduled()
                           │  GET v2/dns_servers + v2/devices  (AdGuard API)
                           │  read/write KV "state"
                           │  PUT …/settings on each off switch  (auto turn-on)
                           ▼
                     POST WEBHOOK_URLS ──▶ chat bot ──▶ you
                                              │           │
                                              │◀──────────┘ "snooze" / "turn on"
                     Worker.fetch() ◀─────────┤ snooze: POST snooze URL
                     AdGuard API    ◀─────────┘ turn on: bot's own AdGuard access
```

- **Runtime:** a Cloudflare Worker on the free plan, written in TypeScript.
- **State:** one Workers KV key, `state`.
- **AdGuard API:** `https://api.adguard-dns.io/oapi`, with the header `Authorization: ApiKey <key>`.
  - Reading, two calls per check:
    - `GET /oapi/v2/dns_servers`: the server with `ADGUARD_SERVER_ID`, `settings.protection_enabled`.
    - `GET /oapi/v2/devices`: every device with `name` and `settings.protection_enabled` inline, keeping only those on that server.
  - Writing: `PUT /oapi/v1/dns_servers/{id}/settings` or `PUT /oapi/v1/devices/{id}/settings` with `{"protection_enabled": true}`.

## State (KV key `state`)

A state machine, so impossible combinations (reminded *and* snoozed) can't be stored:

```ts
type Watch =
  | { phase: "off";      offSince: number }
  | { phase: "reminded"; offSince: number; remindedAt: number; snoozeCode: string }
  | { phase: "snoozed";  offSince: number; snoozeUntil: number };
```

If the key is missing, protection was on at the last check. Stored state that doesn't parse as a `Watch` counts as an error, so the fail-safe turns protection on.

The decisions live in two pure functions in `src/domain.ts`. `decide(watch, off, now, config, newCode)` returns the next `Watch` and at most one effect (`remind` or `turnOn`). `applySnooze(watch, code, minutes, now)` handles the snooze endpoint. Everything with side effects (AdGuard, KV, webhooks) is in `src/index.ts` and the modules it calls.

The free plan allows **1,000 KV writes a day**, and the cron runs 288 times a day. The Worker therefore writes to KV only when the state changes. A normal day takes a handful of writes.

## Check logic (`scheduled`)

```
switches = [server] + devices on that server      # each: { kind, id, name, enabled }
  # both v2 lists are cursor-paginated (default page size 10): request limit=1000 and follow navigation.next.page_cursor
  on error: log, return (try again next check; the Worker can't do anything without the API)
off = switches where !enabled

# From here on, any error → turnOn(off) (fail-safe).
try:
  { next, effect } = decide(stored watch, off, now, timings, crypto.randomUUID())
    # off empty            → next = null (clear)
    # no watch             → next = off(now)
    # off,  ≥ remindAfter  → remind;  next = reminded(now, code)
    # snoozed, ≥ until     → remind;  next = reminded(now, code)
    # reminded, ≥ autoEnableAfter → turnOn; next = null
  if effect is turnOn:
    if every PUT succeeded: save next      # a failed PUT keeps the overdue reminder, so the next check retries it
    return
  save next                                # KV is written only when the value changed
  if effect is remind: POST webhooks { event: "reminder", ... }   # failures logged, never thrown
catch:
  log, turnOn(off)

turnOn(off):
  PUT protection_enabled=true on each switch   # one failing doesn't stop the rest
  POST webhooks { event: "auto_enabled", off: the ones that turned on }   # best effort
```

The error path's `auto_enabled` message says "The protection check hit an error, so AdGuard DNS protection is back on for …". A rare duplicate is accepted: if the KV delete fails after every PUT succeeded, the fail-safe repeats the (harmless) PUTs and sends a second `auto_enabled` message.

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

The Worker sends a `POST` to each URL in `WEBHOOK_URLS` (comma-separated) with `Content-Type: application/json`. If `WEBHOOK_AUTH` is set, it's sent as the `Authorization` header (e.g. `Bearer <key>`).

```json
{
  "event": "reminder",
  "message": "AdGuard DNS protection is off for MacBook Pro (1h). Reply \"snooze\" (or \"snooze 20m\") or \"turn on\". It turns back on automatically in ~5 min.",
  "off_since": "2026-11-04T19:02:00Z",
  "auto_enable_at": "2026-11-04T20:07:00Z",
  "off": [
    { "kind": "device", "id": "<device-id>", "name": "MacBook Pro" }
  ],
  "snooze": { "method": "POST", "url": "https://<worker>/snooze?code=…", "params": { "minutes": "integer, default 60" } }
}
```

```json
{
  "event": "auto_enabled",
  "message": "No reply, so AdGuard DNS protection is back on for MacBook Pro.",
  "off_since": "2026-11-04T19:02:00Z",
  "off": [
    { "kind": "device", "id": "<device-id>", "name": "MacBook Pro" }
  ]
}
```

Messages give relative times ("~5 min") so the Worker needs no time zone setting. The payload carries data only, never instructions: a well-behaved bot won't follow instructions that arrive in a webhook.

### Bot rules

Save these in the bot's own instructions (not in the webhook):

> For webhooks from `adguard-protection-watch`:
> - `event: "reminder"`: send me the `message`.
> - If I then reply "snooze" or "snooze <duration>": convert the duration to whole minutes (default 60) and send an HTTP **POST** to the `snooze.url` from the most recent reminder, with `&minutes=<N>` added to the end.
> - If I reply "turn on": for every item in the most recent reminder's `off` list, set `protection_enabled=true` using your AdGuard DNS API access. `kind: "server"` → `PUT /dns_servers/{id}/settings`. `kind: "device"` → `PUT /devices/{id}/settings`. Then tell me which ones you turned on.
> - If my reply is unclear, do nothing (protection turns back on by itself).
> - `event: "auto_enabled"`: send me the `message`. No action needed.

If the bot can only forward messages, it still works: tap the snooze link and press the button on the page, or flip the toggle yourself. Doing nothing is safe, because protection comes back on by itself.

## Configuration

| Name | Kind | Committed? | Value |
|---|---|---|---|
| `REMIND_AFTER_MIN` | var | yes | `60` |
| `AUTO_ENABLE_AFTER_MIN` | var | yes | `5` |
| `DEFAULT_SNOOZE_MIN` | var | yes | `60` |
| `STATE` | KV binding | yes (namespace id) | — |
| cron | trigger | yes | `*/5 * * * *` |
| `ADGUARD_DNS_API_KEY` | secret | **no** | AdGuard DNS API key |
| `ADGUARD_SERVER_ID` | secret | **no** | ID of the DNS server to watch (from `GET /oapi/v1/dns_servers`) |
| `WEBHOOK_URLS` | secret | **no** | Webhook URL(s), comma-separated. Anyone holding one can message the bot. |
| `WEBHOOK_AUTH` | secret | **no** | Optional `Authorization` header value for the webhook, e.g. `Bearer <key>` |
| `PUBLIC_URL` | secret | **no** | The Worker's own URL (e.g. `https://adguard-protection-watch.<subdomain>.workers.dev`), used to build snooze links. A cron run has no request URL to derive it from. Without it, reminders omit `snooze`. |

## Repo and deploy

- No secrets in git. Secrets are set with `wrangler secret put`, and local dev reads `.dev.vars`, which is gitignored.
- Deploy with `wrangler deploy`. No CI.
- Cloudflare access: an API token from the "Edit Cloudflare Workers" template, plus the account ID.

```
adguard-protection-watch/
  src/index.ts          # scheduled() + fetch()
  src/adguard.ts        # get/set protection
  src/state.ts          # KV read/write
  src/domain.ts         # Watch state machine: decide(), applySnooze() (pure)
  src/config.ts         # env → typed settings, with defaults
  src/webhook.ts        # payloads + delivery
  test/domain.test.ts   # pure reducer tests
  test/worker.test.ts   # real scheduled/fetch handlers, miniflare KV, stubbed AdGuard + webhook
                        # vitest 4 + @cloudflare/vitest-plugin (the renamed vitest-pool-workers)
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

## End-to-end check against a real server

1. Deploy with `REMIND_AFTER_MIN=5` and `AUTO_ENABLE_AFTER_MIN=5`.
2. Turn protection off for **one device** in the dashboard. A reminder naming that device should arrive in the bot within about 10 minutes.
3. Reply "snooze 5m". The next reminder should arrive about 5 minutes after the snooze ends.
4. Ignore it. Protection should come back on within about 5 minutes, with an `auto_enabled` message.
5. Turn protection off again, wait for the reminder, and reply "turn on". The bot should turn protection on, and the next check should clear the state.
6. Temporarily set `WEBHOOK_URLS` to an address that doesn't work, turn protection off, and wait. Protection should come back on with no reminder.
7. Set the timers back to 60 and 5, restore `WEBHOOK_URLS`, and deploy again.

## Verified (2026-11-04)

These were tested against a real AdGuard DNS account (one server, three devices) before building.

**The AdGuard API and the two kinds of toggle:**
- The public API's server `protection_enabled` (`PUT /dns_servers/{id}/settings`) is the **server** toggle on the dashboard. Setting it to `false` stopped filtering after about 10 seconds, setting it to `true` brought filtering back, and the dashboard's server toggle showed each change.
- A device's `protection_enabled` is that device's toggle. Turning one device off in the dashboard showed up as `false` in `GET /oapi/v2/devices`, with the server and other devices still `true`, and filtering stopped for that device only. Setting it back to `true` through the API restored filtering.
- The **account-wide** "Protection is enabled" toggle at the top of Home also stops filtering, but it changes nothing the public API returns. Server and device `protection_enabled` both stayed `true`. No endpoint in the OpenAPI spec reads or changes it.
- A reliable way to check whether filtering is really live: look up a made-up name under a domain one of your rules blocks (e.g. `<random>.example-blocked-tld`). A blocked answer (`0.0.0.0`) means on, and "doesn't exist" means off.

**The chat bot (tested with a Cursor Automation webhook, `Authorization: Bearer <key>`):**
- It accepts the webhook and messages you.
- It ignores instructions sent inside a webhook, so the handling rules belong in the bot's own saved settings (see Bot rules).
- When the user replied "snooze for 20 minutes", the bot sent `POST <snooze.url>&minutes=20` to the link from the earlier reminder. So it keeps the reminder's context when a reply comes in.
- When the user replied "turn on" to a reminder listing one device, the bot set that device's `protection_enabled=true`, said which device it turned on, and didn't call the snooze link.

## Build steps

1. ~~Check what the bot's webhook expects, and confirm the server and device toggles in the API.~~ Done (see Verified).
2. ~~Create the GitHub repo.~~ Done.
3. ~~Scaffold the Worker.~~ Done.
4. ~~Write the domain, then the shell, with tests.~~ Done: 60 tests, plus a mutation check where 10 deliberate breakages each turn at least one test red.
5. Create the KV namespace, put in the secrets, and deploy.
6. Run the end-to-end check above.
7. Add the bot rules to the bot.

## Out of scope

- Pausing from chat, or timed pauses ("pause 20 min").
- Separate timers, snoozes or replies per device (one shared timer instead).
- The account-wide Home toggle. The public API can't see it; use a server or device toggle instead.
- Watching more than one DNS server.
- Built-in notification services (Pushover, ntfy, email). The webhook can point at any of them.
- Quiet hours.
- AdGuard API outages: that's AdGuard's problem, not this tool's. The Worker only retries at the next check, and errors go to the Worker logs with no alert.
- CI or automated deploys.
