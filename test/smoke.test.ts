import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index";

it("runs inside workerd with the KV binding", async () => {
  await env.STATE.put("k", "v");
  expect(await env.STATE.get("k")).toBe("v");
  const res = await worker.fetch();
  expect(await res.text()).toBe("ok");
  expect(env.ADGUARD_DNS_API_KEY).toBe("test-api-key");
});
