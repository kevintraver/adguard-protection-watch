import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Fixed fakes so a real key exported in the shell never reaches a test.
      miniflare: {
        bindings: {
          ADGUARD_DNS_API_KEY: "test-api-key",
          ADGUARD_SERVER_ID: "srv1",
          WEBHOOK_URLS: "https://bot.test/hook",
          PUBLIC_URL: "https://watch.test",
        },
      },
    }),
  ],
});
