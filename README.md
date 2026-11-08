# AdGuard Protection Watch

A Cloudflare Worker that turns AdGuard DNS protection back on when you forget.

Every 5 minutes it reads your DNS server and every device on it. If protection has been off for an hour, it sends a reminder to every registered webhook: a chat bot, Slack, Discord, ntfy or any URL that takes a POST. You can snooze the reminder or turn protection on, from the bot or from the reminder's link. If nobody answers within 5 minutes, the Worker turns protection on itself. If anything goes wrong while protection is off, the Worker turns protection on.

The Worker watches the server toggle and each device toggle. It can't see the account-wide toggle at the top of the dashboard's Home page, because the public API doesn't expose it.

[PLAN.md](PLAN.md) is the full spec. It covers the behavior, the failure handling, the webhook payload, and the end-to-end check.

## Set up

You need an AdGuard DNS API key and a Cloudflare API token from the "Edit Cloudflare Workers" template. Wrangler reads the token from `CLOUDFLARE_API_TOKEN` and the account from `CLOUDFLARE_ACCOUNT_ID`. The commands below run under `fnox exec --`, which supplies both from `fnox.local.toml`. Without fnox, export both variables and drop the prefix.

1. Install the dependencies.

   ```sh
   npm install
   ```

2. Set the secrets. Wrangler prompts for each value.

   ```sh
   fnox exec -- npx wrangler secret put ADGUARD_DNS_API_KEY
   fnox exec -- npx wrangler secret put ADGUARD_SERVER_ID
   fnox exec -- npx wrangler secret put PUBLIC_URL
   fnox exec -- npx wrangler secret put ADMIN_TOKEN
   ```

   | Secret | Value |
   |---|---|
   | `ADGUARD_DNS_API_KEY` | Your AdGuard DNS API key. |
   | `ADGUARD_SERVER_ID` | The ID of the DNS server to watch, from `GET /oapi/v1/dns_servers`. |
   | `PUBLIC_URL` | The Worker's own URL, such as `https://adguard-protection-watch.<subdomain>.workers.dev`. Reminders use it to build the snooze link. |
   | `ADMIN_TOKEN` | A long random string, such as the output of `openssl rand -hex 32`. It guards the `/webhooks` endpoints. |

3. Deploy.

   ```sh
   fnox exec -- npx wrangler deploy
   ```

   The state lives in a Durable Object, `WatchKeeper`, declared under `exports` in `wrangler.jsonc`. The first deploy creates it, so there's nothing to set up by hand. It uses SQLite storage, which the Workers Free plan supports.

4. Add your webhooks. The Worker sends each one a test message and saves it only if that works. A new webhook gets the next message, with no redeploy.

   ```sh
   curl -X POST https://adguard-protection-watch.<subdomain>.workers.dev/webhooks \
     -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
     -d '{"name": "My bot", "url": "https://…", "headers": {"Authorization": "Bearer …"}}'
   ```

   `headers` is optional and goes only to that webhook. `format` is `json` (the default, for bots), `slack`, `discord` or `text` (plain text, such as ntfy). `GET /webhooks` lists them and `DELETE /webhooks/{id}` removes one. A bot that holds `ADMIN_TOKEN` can add itself. Posting the same URL again updates that entry. See [Managing webhooks](PLAN.md#managing-webhooks).

5. For a bot, save the bot rules from [PLAN.md](PLAN.md#bot-rules) in the bot's own instructions. The webhook carries data only, so the bot needs those rules to act on a reply. Slack, Discord and text messages carry a link to a page with "Turn protection on now" and "Snooze" buttons instead.

The timings live in `vars` in `wrangler.jsonc`. `REMIND_AFTER_MIN` defaults to 60, `AUTO_ENABLE_AFTER_MIN` to 5, and `DEFAULT_SNOOZE_MIN` to 60. A missing or invalid value falls back to its default.

## Develop

```sh
npm test            # vitest inside the Workers runtime
npm run typecheck   # tsc --noEmit
npm run types       # regenerate worker-configuration.d.ts after editing wrangler.jsonc
```

For `wrangler dev`, copy `.dev.vars.example` to `.dev.vars` and fill it in.
