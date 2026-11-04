import { createScheduledController, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 4, 19, 0);
const PAGE_SIZE = 2;

type Toggle = { id: string; name: string; protection_enabled: boolean };
type Device = Toggle & { dns_server_id: string };

class World {
  servers: Toggle[] = [
    { id: "srv1", name: "Home", protection_enabled: true },
    { id: "srv2", name: "Office", protection_enabled: true },
  ];
  devices: Device[] = [
    { id: "d1", name: "MacBook Pro", dns_server_id: "srv1", protection_enabled: true },
    { id: "d2", name: "iPhone", dns_server_id: "srv1", protection_enabled: true },
    { id: "d3", name: "Work laptop", dns_server_id: "srv2", protection_enabled: true },
  ];
  adguardDown = false;
  failingPuts = new Set<string>();
  webhookResponse: "ok" | "500" | "network error" = "ok";
  puts: string[] = [];
  webhooks: { url: string; auth: string | null; payload: any }[] = [];

  setOff(id: string, off = true) {
    const toggle = [...this.servers, ...this.devices].find((t) => t.id === id);
    if (!toggle) throw new Error(`no switch ${id}`);
    toggle.protection_enabled = !off;
  }

  isOn(id: string) {
    return [...this.servers, ...this.devices].find((t) => t.id === id)?.protection_enabled;
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin === "https://bot.test" || url.origin === "https://bot2.test") {
      this.webhooks.push({ url: url.href, auth: request.headers.get("authorization"), payload: await request.json() });
      if (this.webhookResponse === "network error") throw new TypeError("network connection lost");
      return new Response(null, { status: this.webhookResponse === "ok" ? 200 : 500 });
    }
    if (url.origin !== "https://api.adguard-dns.io") throw new Error(`unexpected request to ${url.href}`);
    if (request.headers.get("authorization") !== "ApiKey test-api-key") return new Response(null, { status: 401 });
    if (this.adguardDown) return new Response("upstream error", { status: 503 });

    const list = (items: object[]) => {
      const start = Number(url.searchParams.get("cursor") ?? 0);
      const end = start + PAGE_SIZE;
      const next = end < items.length ? { page_cursor: String(end), page_number: end / PAGE_SIZE + 1 } : undefined;
      return Response.json({ items: items.slice(start, end), navigation: next ? { next } : {} });
    };
    const settings = ({ protection_enabled }: Toggle) => ({ protection_enabled, doh_auth_enabled: false });

    if (request.method === "GET" && url.pathname === "/oapi/v2/dns_servers") {
      return list(this.servers.map((s) => ({ id: s.id, name: s.name, default: false, devices_count: 1, settings: settings(s) })));
    }
    if (request.method === "GET" && url.pathname === "/oapi/v2/devices") {
      return list(this.devices.map((d) => ({ id: d.id, name: d.name, dns_server_id: d.dns_server_id, settings: settings(d) })));
    }
    const put = url.pathname.match(/^\/oapi\/v1\/(dns_servers|devices)\/([^/]+)\/settings$/);
    if (request.method === "PUT" && put) {
      const [, collection, id] = put;
      const target = (collection === "dns_servers" ? this.servers : this.devices).find((t) => t.id === id);
      if (!target) return new Response(null, { status: 404 });
      if (this.failingPuts.has(id!)) return new Response("boom", { status: 500 });
      const body: { protection_enabled?: boolean } = await request.json();
      this.puts.push(`${collection}/${id}`);
      if (body.protection_enabled !== undefined) target.protection_enabled = body.protection_enabled;
      return new Response(null, { status: 200 });
    }
    return new Response(null, { status: 404 });
  }
}

let world: World;

beforeEach(async () => {
  await reset();
  world = new World();
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => world.handle(new Request(input, init)));
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Kv = Pick<KVNamespace, "get" | "put" | "delete">;

function bindings(overrides: Record<string, unknown> = {}): Env {
  return { ...env, ...overrides } as Env;
}

function countingKv() {
  const writes: string[] = [];
  const kv: Kv = {
    get: ((key: string) => env.STATE.get(key)) as KVNamespace["get"],
    put: ((key: string, value: string) => (writes.push(`put ${key}`), env.STATE.put(key, value))) as KVNamespace["put"],
    delete: (key: string) => (writes.push(`delete ${key}`), env.STATE.delete(key)),
  };
  return { writes, env: bindings({ STATE: kv }) };
}

async function checkAt(minutes: number, e: Env = bindings()) {
  vi.setSystemTime(T0 + minutes * MIN);
  await worker.scheduled(createScheduledController({ scheduledTime: T0 + minutes * MIN, cron: "*/5 * * * *" }), e);
}

async function request(minutes: number, method: string, url: string, init: RequestInit = {}, e: Env = bindings()) {
  vi.setSystemTime(T0 + minutes * MIN);
  return worker.fetch(new Request(url, { method, ...init }), e);
}

const stored = () => env.STATE.get<Record<string, unknown>>("state", "json");
const events = () => world.webhooks.map((w) => w.payload.event);
const lastPayload = () => world.webhooks.at(-1)!.payload;

async function remindedFromMinute0() {
  world.setOff("d1");
  await checkAt(0);
  await checkAt(60);
  expect(events()).toEqual(["reminder"]);
  return lastPayload();
}

describe("normal flow", () => {
  it("writes nothing while protection is on and nothing is stored", async () => {
    const { writes, env: e } = countingKv();
    await checkAt(0, e);
    await checkAt(5, e);
    expect(writes).toEqual([]);
    expect(await stored()).toBeNull();
    expect(world.webhooks).toEqual([]);
    expect(world.puts).toEqual([]);
  });

  it("deletes stored state once protection is back on", async () => {
    world.setOff("d1");
    await checkAt(0);
    world.setOff("d1", false);
    await checkAt(5);
    expect(await stored()).toBeNull();
  });

  it("records off_since the first time protection is off, then writes nothing until a reminder is due", async () => {
    world.setOff("d1");
    const { writes, env: e } = countingKv();
    await checkAt(0, e);
    expect(await stored()).toEqual({ phase: "off", offSince: T0 });
    for (const minute of [5, 30, 55]) await checkAt(minute, e);
    expect(writes).toEqual(["put state"]);
    expect(world.webhooks).toEqual([]);
  });

  it("sends a reminder after an hour off and stores the snooze code", async () => {
    world.setOff("d1");
    await checkAt(0);
    await checkAt(55);
    expect(world.webhooks).toEqual([]);

    await checkAt(60);
    const state = await stored();
    expect(state).toMatchObject({ phase: "reminded", offSince: T0, remindedAt: T0 + 60 * MIN });
    expect(state?.snoozeCode).toEqual(expect.any(String));
    expect(world.webhooks).toHaveLength(1);
    expect(world.webhooks[0]).toEqual({
      url: "https://bot.test/hook",
      auth: null,
      payload: {
        event: "reminder",
        message:
          'AdGuard DNS protection is off for MacBook Pro (1h). Reply "snooze" (or "snooze 20m") or "turn on". It turns back on automatically in ~5 min.',
        off_since: "2026-11-04T19:00:00.000Z",
        auto_enable_at: "2026-11-04T20:05:00.000Z",
        off: [{ kind: "device", id: "d1", name: "MacBook Pro" }],
        snooze: {
          method: "POST",
          url: `https://watch.test/snooze?code=${state?.snoozeCode}`,
          params: { minutes: "integer, default 60" },
        },
      },
    });
  });

  it("turns protection on and reports it when nobody answers within 5 minutes", async () => {
    await remindedFromMinute0();
    await checkAt(64);
    expect(world.puts).toEqual([]);

    await checkAt(65);
    expect(world.puts).toEqual(["devices/d1"]);
    expect(world.isOn("d1")).toBe(true);
    expect(lastPayload()).toEqual({
      event: "auto_enabled",
      message: "No reply, so AdGuard DNS protection is back on for MacBook Pro.",
      off_since: "2026-11-04T19:00:00.000Z",
      off: [{ kind: "device", id: "d1", name: "MacBook Pro" }],
    });
    expect(await stored()).toBeNull();
  });

  it("snoozes through the reminder's link, stays quiet until the snooze ends, then runs the cycle again", async () => {
    const reminder = await remindedFromMinute0();
    const res = await request(62, "POST", `${reminder.snooze.url}&minutes=20`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, snooze_until: "2026-11-04T20:22:00.000Z" });
    expect(await stored()).toEqual({ phase: "snoozed", offSince: T0, snoozeUntil: T0 + 82 * MIN });

    expect((await request(63, "POST", `${reminder.snooze.url}&minutes=20`)).status).toBe(410);

    for (const minute of [65, 70, 75, 80]) await checkAt(minute);
    expect(events()).toEqual(["reminder"]);
    expect(world.puts).toEqual([]);

    await checkAt(85);
    expect(events()).toEqual(["reminder", "reminder"]);
    const second = lastPayload();
    expect(second.message).toContain("(1h 25 min)");
    expect(second.snooze.url).not.toBe(reminder.snooze.url);

    await checkAt(90);
    expect(world.puts).toEqual(["devices/d1"]);
    expect(events()).toEqual(["reminder", "reminder", "auto_enabled"]);
  });

  it("snoozes for the default 60 minutes when no length is given", async () => {
    const reminder = await remindedFromMinute0();
    const res = await request(62, "POST", reminder.snooze.url);
    expect(await res.json()).toEqual({ ok: true, snooze_until: "2026-11-04T21:02:00.000Z" });
  });

  it("accepts a very long snooze", async () => {
    const reminder = await remindedFromMinute0();
    const res = await request(62, "POST", `${reminder.snooze.url}&minutes=10000`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, snooze_until: new Date(T0 + 10_062 * MIN).toISOString() });
    await checkAt(10_060);
    expect(events()).toEqual(["reminder"]);
  });

  it("sends WEBHOOK_AUTH as the Authorization header to every webhook URL", async () => {
    const e = bindings({ WEBHOOK_URLS: "https://bot.test/hook, https://bot2.test/other", WEBHOOK_AUTH: "Bearer secret" });
    world.setOff("d1");
    await checkAt(0, e);
    await checkAt(60, e);
    expect(world.webhooks.map(({ url, auth }) => ({ url, auth }))).toEqual([
      { url: "https://bot.test/hook", auth: "Bearer secret" },
      { url: "https://bot2.test/other", auth: "Bearer secret" },
    ]);
  });
});

describe("devices", () => {
  it("watches a single device with the server on, and turns on only that device", async () => {
    const reminder = await remindedFromMinute0();
    expect(reminder.off).toEqual([{ kind: "device", id: "d1", name: "MacBook Pro" }]);
    await checkAt(65);
    expect(world.puts).toEqual(["devices/d1"]);
  });

  it("lists the server and a device when both are off, and turns both on", async () => {
    world.setOff("srv1");
    world.setOff("d2");
    await checkAt(0);
    await checkAt(60);
    expect(lastPayload().off).toEqual([
      { kind: "server", id: "srv1", name: "Home" },
      { kind: "device", id: "d2", name: "iPhone" },
    ]);
    expect(lastPayload().message).toContain("off for all devices on Home and iPhone (1h)");
    await checkAt(65);
    expect(world.puts.sort()).toEqual(["devices/d2", "dns_servers/srv1"]);
  });

  it("keeps the first off_since when a second device goes off partway through", async () => {
    world.setOff("d1");
    await checkAt(0);
    world.setOff("d2");
    await checkAt(50);
    expect(await stored()).toEqual({ phase: "off", offSince: T0 });
    await checkAt(60);
    expect(lastPayload()).toMatchObject({
      off_since: "2026-11-04T19:00:00.000Z",
      off: [
        { kind: "device", id: "d1", name: "MacBook Pro" },
        { kind: "device", id: "d2", name: "iPhone" },
      ],
    });
  });

  it("keeps the timer running when one device comes back on and another stays off", async () => {
    world.setOff("d1");
    world.setOff("d2");
    await checkAt(0);
    world.setOff("d1", false);
    await checkAt(30);
    await checkAt(60);
    expect(lastPayload()).toMatchObject({ off_since: "2026-11-04T19:00:00.000Z", off: [{ id: "d2" }] });
  });

  it("ignores devices on other servers and picks up a newly added device", async () => {
    world.setOff("d3");
    world.setOff("srv2");
    await checkAt(0);
    expect(await stored()).toBeNull();

    world.devices.push({ id: "d4", name: "New tablet", dns_server_id: "srv1", protection_enabled: false });
    await checkAt(5);
    await checkAt(65);
    expect(lastPayload().off).toEqual([{ kind: "device", id: "d4", name: "New tablet" }]);
    await checkAt(70);
    expect(world.puts).toEqual(["devices/d4"]);
  });

  it("turns on the rest when one PUT fails, and retries the failed one at the next check", async () => {
    world.setOff("d1");
    world.setOff("d2");
    world.failingPuts.add("d1");
    await checkAt(0);
    await checkAt(60);
    await checkAt(65);
    expect(world.isOn("d2")).toBe(true);
    expect(world.isOn("d1")).toBe(false);
    expect(lastPayload()).toMatchObject({ event: "auto_enabled", off: [{ id: "d2" }] });

    world.failingPuts.clear();
    await checkAt(70);
    expect(world.isOn("d1")).toBe(true);
    expect(lastPayload()).toMatchObject({ event: "auto_enabled", off: [{ id: "d1" }] });
    expect(await stored()).toBeNull();
  });
});

describe("fail-safe", () => {
  it.each(["500", "network error"] as const)(
    "counts a reminder as sent when the webhook fails (%s) and turns protection on at the next check",
    async (failure) => {
      world.webhookResponse = failure;
      world.setOff("d1");
      await checkAt(0);
      await checkAt(60);
      expect(events()).toEqual(["reminder"]);
      expect(await stored()).toMatchObject({ phase: "reminded" });
      await checkAt(65);
      expect(world.puts).toEqual(["devices/d1"]);
      expect(world.isOn("d1")).toBe(true);
    },
  );

  it("turns protection on when the KV read throws while protection is off", async () => {
    world.setOff("d1");
    const kv: Kv = { ...countingKv().env.STATE, get: (() => Promise.reject(new Error("KV down"))) as KVNamespace["get"] };
    await checkAt(0, bindings({ STATE: kv }));
    expect(world.puts).toEqual(["devices/d1"]);
    expect(lastPayload()).toEqual({
      event: "auto_enabled",
      message: "The protection check hit an error, so AdGuard DNS protection is back on for MacBook Pro.",
      off: [{ kind: "device", id: "d1", name: "MacBook Pro" }],
    });
  });

  it("turns protection on when the KV write throws while protection is off", async () => {
    world.setOff("d1");
    const kv: Kv = { ...countingKv().env.STATE, put: () => Promise.reject(new Error("KV write limit")) };
    await checkAt(0, bindings({ STATE: kv }));
    expect(world.puts).toEqual(["devices/d1"]);
    expect(world.isOn("d1")).toBe(true);
  });

  it("turns protection on after an unexpected error such as corrupt stored state", async () => {
    world.setOff("d1");
    await env.STATE.put("state", "{not json");
    await checkAt(0);
    expect(world.puts).toEqual(["devices/d1"]);
    expect(events()).toEqual(["auto_enabled"]);
  });

  it("does nothing on a KV failure while everything is on", async () => {
    const kv: Kv = { ...countingKv().env.STATE, get: (() => Promise.reject(new Error("KV down"))) as KVNamespace["get"] };
    await checkAt(0, bindings({ STATE: kv }));
    expect(world.puts).toEqual([]);
    expect(world.webhooks).toEqual([]);
  });

  it.each([
    ["missing", {}],
    ["invalid", { REMIND_AFTER_MIN: "soon", AUTO_ENABLE_AFTER_MIN: "0", DEFAULT_SNOOZE_MIN: "-5" }],
    ["fractional", { REMIND_AFTER_MIN: "1.5", AUTO_ENABLE_AFTER_MIN: "2.5", DEFAULT_SNOOZE_MIN: "" }],
  ])("falls back to 60 / 5 / 60 when settings are %s", async (_, overrides) => {
    const e = bindings({ REMIND_AFTER_MIN: undefined, AUTO_ENABLE_AFTER_MIN: undefined, DEFAULT_SNOOZE_MIN: undefined, ...overrides });
    world.setOff("d1");
    await checkAt(0, e);
    await checkAt(55, e);
    expect(world.webhooks).toEqual([]);
    await checkAt(60, e);
    expect(lastPayload().snooze.params).toEqual({ minutes: "integer, default 60" });
    await checkAt(64, e);
    expect(world.puts).toEqual([]);
    await checkAt(65, e);
    expect(world.puts).toEqual(["devices/d1"]);
  });

  it("uses valid configured timings", async () => {
    const e = bindings({ REMIND_AFTER_MIN: "5", AUTO_ENABLE_AFTER_MIN: "10" });
    world.setOff("d1");
    await checkAt(0, e);
    await checkAt(5, e);
    expect(lastPayload().message).toContain("in ~10 min");
    await checkAt(10, e);
    expect(world.puts).toEqual([]);
    await checkAt(15, e);
    expect(world.puts).toEqual(["devices/d1"]);
  });

  it("rejects a wrong code with 404 and leaves the reminder to auto turn-on", async () => {
    const reminder = await remindedFromMinute0();
    const before = await stored();
    for (const url of ["https://watch.test/snooze?code=wrong&minutes=20", "https://watch.test/snooze?minutes=20"]) {
      expect((await request(62, "POST", url)).status).toBe(404);
    }
    expect((await request(62, "GET", "https://watch.test/snooze?code=wrong")).status).toBe(404);
    expect(await stored()).toEqual(before);
    await checkAt(65);
    expect(world.puts).toEqual(["devices/d1"]);
    expect(reminder.event).toBe("reminder");
  });

  it("answers 410 when no reminder is pending, leaving state unchanged", async () => {
    world.setOff("d1");
    await checkAt(0);
    const res = await request(10, "POST", "https://watch.test/snooze?code=anything&minutes=20");
    expect(res.status).toBe(410);
    expect(await stored()).toEqual({ phase: "off", offSince: T0 });
    expect((await request(10, "GET", "https://watch.test/snooze?code=anything")).status).toBe(410);
  });

  it.each(["0", "-1", "1.5", "abc", "1e3", ""])("rejects minutes=%s with 400 and changes nothing", async (minutes) => {
    const reminder = await remindedFromMinute0();
    const before = await stored();
    const res = await request(62, "POST", `${reminder.snooze.url}&minutes=${minutes}`);
    expect(res.status).toBe(400);
    expect(await stored()).toEqual(before);
    await checkAt(65);
    expect(world.puts).toEqual(["devices/d1"]);
  });

  it("serves a snooze form on GET without changing state, and the form's POST snoozes", async () => {
    const reminder = await remindedFromMinute0();
    const before = await stored();
    const page = await request(62, "GET", `${reminder.snooze.url}&minutes=20`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    const body = await page.text();
    expect(body).toContain('<form method="post">');
    expect(body).toContain('name="minutes"');
    expect(await stored()).toEqual(before);

    const submitted = await request(62, "POST", reminder.snooze.url, {
      body: new URLSearchParams({ minutes: "30" }),
    });
    expect(submitted.status).toBe(200);
    expect(await submitted.text()).toContain("Snoozed for 30 min");
    expect(await stored()).toEqual({ phase: "snoozed", offSince: T0, snoozeUntil: T0 + 92 * MIN });
  });

  it("leaves state alone and does not throw when the AdGuard API is down", async () => {
    world.setOff("d1");
    await checkAt(0);
    world.adguardDown = true;
    const { writes, env: e } = countingKv();
    await expect(checkAt(65, e)).resolves.toBeUndefined();
    expect(writes).toEqual([]);
    expect(await stored()).toEqual({ phase: "off", offSince: T0 });
    expect(world.webhooks).toEqual([]);
  });

  it("treats an unknown ADGUARD_SERVER_ID as an API error", async () => {
    world.setOff("d1");
    await checkAt(0, bindings({ ADGUARD_SERVER_ID: "nope" }));
    expect(await stored()).toBeNull();
    expect(world.puts).toEqual([]);
  });
});

describe("other routes", () => {
  it("answers the health check without showing state", async () => {
    world.setOff("d1");
    await checkAt(0);
    const res = await request(1, "GET", "https://watch.test/");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it.each([
    ["GET", "https://watch.test/state"],
    ["POST", "https://watch.test/"],
    ["DELETE", "https://watch.test/snooze?code=x"],
  ])("answers 404 for %s %s", async (method, url) => {
    expect((await request(0, method, url)).status).toBe(404);
  });
});
