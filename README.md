# AdGuard Protection Watch

A Cloudflare Worker that turns AdGuard DNS protection back on when you forget.

Every 5 minutes it reads your DNS server and every device on it. If protection has been off for an hour, it sends a reminder webhook to a chat bot. You can snooze the reminder or have the bot turn protection on. If nobody answers within 5 minutes, the Worker turns protection on itself. If anything goes wrong while protection is off, the Worker turns protection on.

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
   fnox exec -- npx wrangler secret put WEBHOOK_URLS
   fnox exec -- npx wrangler secret put PUBLIC_URL
   fnox exec -- npx wrangler secret put WEBHOOK_AUTH
   ```

   | Secret | Value |
   |---|---|
   | `ADGUARD_DNS_API_KEY` | Your AdGuard DNS API key. |
   | `ADGUARD_SERVER_ID` | The ID of the DNS server to watch, from `GET /oapi/v1/dns_servers`. |
   | `WEBHOOK_URLS` | One or more webhook URLs, separated by commas. Anyone who has one can message the bot. |
   | `PUBLIC_URL` | The Worker's own URL, such as `https://adguard-protection-watch.<subdomain>.workers.dev`. Reminders use it to build the snooze link. |
   | `WEBHOOK_AUTH` | Optional. Sent as the webhook's `Authorization` header, such as `Bearer <key>`. |

3. Deploy.

   ```sh
   fnox exec -- npx wrangler deploy
   ```

   The state lives in a Durable Object, `WatchKeeper`, declared under `exports` in `wrangler.jsonc`. The first deploy creates it, so there's nothing to set up by hand. It uses SQLite storage, which the Workers Free plan supports.

4. Save the bot rules from [PLAN.md](PLAN.md#bot-rules) in the bot's own instructions. The webhook carries data only, so the bot needs those rules to act on a reply.

The timings live in `vars` in `wrangler.jsonc`. `REMIND_AFTER_MIN` defaults to 60, `AUTO_ENABLE_AFTER_MIN` to 5, and `DEFAULT_SNOOZE_MIN` to 60. A missing or invalid value falls back to its default.

## Develop

```sh
npm test            # vitest inside the Workers runtime
npm run typecheck   # tsc --noEmit
npm run types       # regenerate worker-configuration.d.ts after editing wrangler.jsonc
```

For `wrangler dev`, copy `.dev.vars.example` to `.dev.vars` and fill it in.
