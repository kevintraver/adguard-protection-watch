import { createScheduledController, reset, runInDurableObject } from "cloudflare:test";
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
  webhooks: { url: string; auth: string | null; contentType: string | null; payload: any }[] = [];
  signatures: { raw: string; signature: string | null }[] = [];
  onWebhook: ((payload: any) => Promise<void>) | null = null;
  slowMs: Partial<Record<string, number>> = {};
  started: string[] = [];

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
      const contentType = request.headers.get("content-type");
      const raw = await request.text();
      const payload = contentType?.startsWith("application/json") ? JSON.parse(raw) : raw;
      this.signatures.push({ raw, signature: request.headers.get("x-signature-256") });
      this.webhooks.push({ url: url.href, auth: request.headers.get("authorization"), contentType, payload });
      await this.onWebhook?.(payload);
      if (this.webhookResponse === "network error") throw new TypeError("network connection lost");
      return new Response(null, { status: this.webhookResponse === "ok" ? 200 : 500 });
    }
    if (url.origin !== "https://api.adguard-dns.io") throw new Error(`unexpected request to ${url.href}`);
    if (request.headers.get("authorization") !== "ApiKey test-api-key") return new Response(null, { status: 401 });
    if (this.adguardDown) return new Response("upstream error", { status: 503 });
    this.started.push(request.method);
    const slowMs = this.slowMs[request.method];
    if (slowMs) await new Promise((resolve) => setTimeout(resolve, slowMs));

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
  expect((await register({ name: "Bot", url: "https://bot.test/hook" })).status).toBe(201);
  world.webhooks = [];
  world.signatures = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function bindings(overrides: Record<string, unknown> = {}): Env {
  return { ...env, ...overrides } as Env;
}

const keeper = () => env.WATCH.getByName("watch");

function breakStorage(method: "get" | "put" | "delete", key: string | null = "watch") {
  return runInDurableObject(keeper(), (_, state) => {
    const kv = state.storage.kv;
    const original = kv[method].bind(kv) as (...args: unknown[]) => unknown;
    vi.spyOn(kv, method).mockImplementation(((...args: unknown[]) => {
      if (key === null || args[0] === key) throw new Error(`storage ${method} failed`);
      return original(...args);
    }) as never);
  });
}

const ADMIN = { Authorization: "Bearer test-admin-token" };

function register(body: unknown, headers: Record<string, string> = ADMIN) {
  return worker.fetch(
    new Request("https://watch.test/webhooks", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    bindings(),
  );
}

function admin(method: string, path: string, headers: Record<string, string> = ADMIN, e: Env = bindings()) {
  return worker.fetch(new Request(`https://watch.test${path}`, { method, headers }), e);
}

async function checkAt(minutes: number, e: Env = bindings()) {
  vi.setSystemTime(T0 + minutes * MIN);
  await worker.scheduled(createScheduledController({ scheduledTime: T0 + minutes * MIN, cron: "*/5 * * * *" }), e);
}

async function request(minutes: number, method: string, url: string, init: RequestInit = {}, e: Env = bindings()) {
  vi.setSystemTime(T0 + minutes * MIN);
  return worker.fetch(new Request(url, { method, ...init }), e);
}

const stored = () => keeper().watch() as Promise<Record<string, unknown> | null>;
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
  it("stores and sends nothing while protection is on", async () => {
    await checkAt(0);
    await checkAt(5);
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

  it("records off_since the first time protection is off, then keeps it until a reminder is due", async () => {
    world.setOff("d1");
    await checkAt(0);
    expect(await stored()).toEqual({ phase: "off", offSince: T0 });
    for (const minute of [5, 30, 55]) await checkAt(minute);
    expect(await stored()).toEqual({ phase: "off", offSince: T0 });
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
      contentType: "application/json",
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
        turn_on: { method: "POST", url: `https://watch.test/turn-on?code=${state?.snoozeCode}` },
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

  it("sends each webhook only its own headers", async () => {
    expect((await register({ name: "Other", url: "https://bot2.test/other", headers: { Authorization: "Bearer two" } })).status).toBe(201);
    world.webhooks = [];
    world.setOff("d1");
    await checkAt(0);
    await checkAt(60);
    expect(world.webhooks.map(({ url, auth }) => ({ url, auth }))).toEqual([
      { url: "https://bot.test/hook", auth: null },
      { url: "https://bot2.test/other", auth: "Bearer two" },
    ]);
  });
});

describe("concurrency", () => {
  it("accepts a snooze sent while the reminder webhook is still being delivered", async () => {
    world.setOff("d1");
    await checkAt(0);
    let status = 0;
    world.onWebhook = async (payload) => {
      status = (await request(60, "POST", `${payload.snooze.url}&minutes=20`)).status;
    };
    await checkAt(60);
    expect(status).toBe(200);
    expect(await stored()).toEqual({ phase: "snoozed", offSince: T0, snoozeUntil: T0 + 80 * MIN });
    await checkAt(65);
    expect(world.puts).toEqual([]);
  });

  it("snoozes, with no turn-on, when the snooze lands while the due check reads AdGuard", async () => {
    const reminder = await remindedFromMinute0();
    world.slowMs.GET = 300;
    world.started = [];
    const checking = checkAt(65);
    await vi.waitUntil(() => world.started.includes("GET"));
    const res = await request(65, "POST", reminder.snooze.url);
    await checking;
    expect(res.status).toBe(200);
    expect(world.puts).toEqual([]);
    expect(events()).toEqual(["reminder"]);
    expect(await stored()).toMatchObject({ phase: "snoozed" });
  });

  it("turns protection on and refuses the snooze with 410 when the snooze lands during the turn-on", async () => {
    const reminder = await remindedFromMinute0();
    world.slowMs.PUT = 300;
    const checking = checkAt(65);
    await vi.waitUntil(() => world.started.includes("PUT"));
    const res = await request(65, "POST", reminder.snooze.url);
    await checking;
    expect(res.status).toBe(410);
    expect(world.puts).toEqual(["devices/d1"]);
    expect(events()).toEqual(["reminder", "auto_enabled"]);
    expect(await stored()).toBeNull();
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

  it("turns protection on when the storage read throws while protection is off", async () => {
    world.setOff("d1");
    await breakStorage("get");
    await checkAt(0);
    expect(world.puts).toEqual(["devices/d1"]);
    expect(lastPayload()).toEqual({
      event: "auto_enabled",
      message: "The protection check hit an error, so AdGuard DNS protection is back on for MacBook Pro.",
      off: [{ kind: "device", id: "d1", name: "MacBook Pro" }],
    });
  });

  it("turns protection on when the storage write throws while protection is off", async () => {
    world.setOff("d1");
    await breakStorage("put");
    await checkAt(0);
    expect(world.puts).toEqual(["devices/d1"]);
    expect(world.isOn("d1")).toBe(true);
  });

  it("turns protection on when the Durable Object can't be reached, with no message since the webhook list lives there", async () => {
    world.setOff("d1");
    const down = () => Promise.reject(new Error("Durable Object overloaded"));
    const unreachable = { getByName: () => ({ check: down, webhooksOrNone: down }) };
    await checkAt(0, bindings({ WATCH: unreachable }));
    expect(world.puts).toEqual(["devices/d1"]);
    expect(world.webhooks).toEqual([]);
  });

  it("turns protection on when every storage read throws", async () => {
    world.setOff("d1");
    await breakStorage("get", null);
    await checkAt(0);
    expect(world.puts).toEqual(["devices/d1"]);
    expect(world.isOn("d1")).toBe(true);
  });

  it("still reminds on schedule and turns protection on when the webhook list is corrupt", async () => {
    await runInDurableObject(keeper(), (_, state) => state.storage.kv.put("webhooks", [{ url: "nope" }]));
    world.setOff("d1");
    await checkAt(0);
    await checkAt(60);
    expect(await stored()).toMatchObject({ phase: "reminded" });
    expect(world.webhooks).toEqual([]);
    await checkAt(65);
    expect(world.puts).toEqual(["devices/d1"]);
  });

  it("turns protection on after the reminder even with no webhooks registered", async () => {
    const [hook] = await (await admin("GET", "/webhooks")).json<{ id: string }[]>();
    expect((await admin("DELETE", `/webhooks/${hook!.id}`)).status).toBe(204);
    world.setOff("d1");
    await checkAt(0);
    await checkAt(60);
    await checkAt(65);
    expect(world.webhooks).toEqual([]);
    expect(world.puts).toEqual(["devices/d1"]);
  });

  it.each([
    ["not a watch at all", "{not json"],
    ["a snooze with no valid end", { phase: "snoozed", offSince: T0, snoozeUntil: "tomorrow" }],
  ])("turns protection on when the stored state is corrupt (%s)", async (_, value) => {
    world.setOff("d1");
    await runInDurableObject(keeper(), (_, state) => state.storage.kv.put("watch", value));
    await checkAt(0);
    expect(world.puts).toEqual(["devices/d1"]);
    expect(events()).toEqual(["auto_enabled"]);
  });

  it("does nothing on a storage failure while everything is on", async () => {
    await breakStorage("get");
    await checkAt(0);
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
    await expect(checkAt(65)).resolves.toBeUndefined();
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

  it("never turns protection on from a GET, so a link preview can't act", async () => {
    const reminder = await remindedFromMinute0();
    expect((await request(62, "GET", reminder.turn_on.url)).status).toBe(404);
    expect(world.puts).toEqual([]);
    expect(await stored()).toMatchObject({ phase: "reminded" });
  });

  it.each([
    ["GET", "https://watch.test/state"],
    ["POST", "https://watch.test/"],
    ["DELETE", "https://watch.test/snooze?code=x"],
  ])("answers 404 for %s %s", async (method, url) => {
    expect((await request(0, method, url)).status).toBe(404);
  });
});

describe("webhook registry", () => {
  it("hides the endpoints when ADGUARD_WATCH_WEBHOOKS_TOKEN is unset, and refuses a wrong token", async () => {
    expect((await admin("GET", "/webhooks", ADMIN, bindings({ ADGUARD_WATCH_WEBHOOKS_TOKEN: "" }))).status).toBe(404);
    expect((await admin("GET", "/webhooks", { Authorization: "Bearer wrong" })).status).toBe(401);
    expect((await admin("GET", "/webhooks", {})).status).toBe(401);
    expect((await register({ name: "Sneaky", url: "https://bot2.test/x" }, { Authorization: "Bearer wrong" })).status).toBe(401);
    expect(world.webhooks).toEqual([]);
  });

  it("sends a test message, saves the webhook, and lists it without its URL path or header values", async () => {
    const res = await register({ name: "Slack", url: "https://bot2.test/secret-path", format: "slack", headers: { "X-Key": "k" } });
    expect(res.status).toBe(201);
    expect(world.webhooks).toEqual([
      {
        url: "https://bot2.test/secret-path",
        auth: null,
        contentType: "application/json",
        payload: { text: 'AdGuard Protection Watch will send its reminders for "Slack" here.' },
      },
    ]);
    const list = await (await admin("GET", "/webhooks")).json<Record<string, unknown>[]>();
    expect(list.map((w) => ({ ...w, id: "…", added_at: "…" }))).toEqual([
      { id: "…", name: "Bot", host: "bot.test", format: "json", header_names: [], signature_header: null, added_at: "…" },
      { id: "…", name: "Slack", host: "bot2.test", format: "slack", header_names: ["X-Key"], signature_header: null, added_at: "…" },
    ]);
    expect(JSON.stringify(list)).not.toContain("secret-path");
  });

  it("replaces the webhook with the same URL instead of adding a second one", async () => {
    const first = await (await register({ name: "Two", url: "https://bot2.test/x", headers: { Authorization: "Bearer old" } })).json<{ id: string }>();
    const again = await register({ name: "Two renamed", url: "https://bot2.test/x", headers: { Authorization: "Bearer new" } });
    expect(again.status).toBe(200);
    expect((await again.json<{ id: string }>()).id).toBe(first.id);
    world.webhooks = [];
    world.setOff("d1");
    await checkAt(0);
    await checkAt(60);
    expect(world.webhooks.map((w) => w.auth)).toEqual([null, "Bearer new"]);
  });

  it.each([
    ["not an object", "[1]"],
    ["no name", { url: "https://bot2.test/x" }],
    ["plain http", { name: "x", url: "http://bot2.test/x" }],
    ["unknown format", { name: "x", url: "https://bot2.test/x", format: "fax" }],
    ["non-string header", { name: "x", url: "https://bot2.test/x", headers: { "X-Key": 1 } }],
    ["invalid header name", { name: "x", url: "https://bot2.test/x", headers: { "bad header": "v" } }],
  ])("rejects a webhook with %s (400)", async (_, body) => {
    expect((await register(body)).status).toBe(400);
    expect((await (await admin("GET", "/webhooks")).json<unknown[]>()).length).toBe(1);
  });

  it("doesn't save a webhook whose test message fails (422)", async () => {
    world.webhookResponse = "500";
    const res = await register({ name: "Broken", url: "https://bot2.test/x" });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "the test message failed: HTTP 500" });
    expect((await (await admin("GET", "/webhooks")).json<unknown[]>()).length).toBe(1);
  });

  it("removes a webhook, which then gets nothing, and answers 404 for an unknown id", async () => {
    const [hook] = await (await admin("GET", "/webhooks")).json<{ id: string }[]>();
    expect((await admin("DELETE", `/webhooks/${hook!.id}`)).status).toBe(204);
    expect((await admin("DELETE", `/webhooks/${hook!.id}`)).status).toBe(404);
    world.setOff("d1");
    await checkAt(0);
    await checkAt(60);
    expect(world.webhooks).toEqual([]);
  });

  it("caps the list at 20 webhooks (409)", async () => {
    for (let i = 2; i <= 20; i++) expect((await register({ name: `n${i}`, url: `https://bot2.test/${i}` })).status).toBe(201);
    expect((await register({ name: "one too many", url: "https://bot2.test/21" })).status).toBe(409);
    expect((await register({ name: "same URL is fine", url: "https://bot2.test/20" })).status).toBe(200);
  });
});

async function hmacHex(secret: string, body: string) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("signed webhooks", () => {
  it("signs every body with HMAC-SHA256 under the webhook's own secret, and never shows the secret", async () => {
    const res = await register({ name: "Signed", url: "https://bot2.test/s", signing: { secret: "vault-secret" } });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ signature_header: "X-Signature-256" });
    world.setOff("d1");
    await checkAt(0);
    await checkAt(60);

    const signed = world.signatures.filter((_, i) => world.webhooks[i]!.url === "https://bot2.test/s");
    expect(signed.map((s) => JSON.parse(s.raw).event)).toEqual(["test", "reminder"]);
    for (const { raw, signature } of signed) expect(signature).toBe(`sha256=${await hmacHex("vault-secret", raw)}`);
    const unsigned = world.signatures.filter((_, i) => world.webhooks[i]!.url === "https://bot.test/hook");
    expect(unsigned.map((s) => s.signature)).toEqual([null]);

    const list = await (await admin("GET", "/webhooks")).text();
    expect(list).not.toContain("vault-secret");
    expect(list).toContain('"signature_header":"X-Signature-256"');
  });

  it("uses a custom signature header and prefix", async () => {
    await register({ name: "Custom", url: "https://bot2.test/c", signing: { secret: "s", header: "X-Signature-256", prefix: "" } });
    const { raw, signature } = world.signatures.at(-1)!;
    expect(signature).toBe(await hmacHex("s", raw));
  });

  it.each([
    ["no secret", {}],
    ["an empty secret", { secret: "" }],
    ["a bad header name", { secret: "s", header: "bad header" }],
    ["not an object", "s"],
  ])("rejects signing with %s (400)", async (_, signing) => {
    expect((await register({ name: "x", url: "https://bot2.test/x", signing })).status).toBe(400);
  });
});

describe("test endpoint", () => {
  it("reads AdGuard and sends a test message to every webhook with its own headers and format", async () => {
    await register({ name: "Slack", url: "https://bot2.test/x", format: "slack", headers: { "X-Key": "k" } });
    world.webhooks = [];
    world.setOff("d1");
    const res = await admin("POST", "/webhooks/test");
    expect(res.status).toBe(200);
    const body = await res.json<{ webhooks: { id: string }[] }>();
    expect({ ...body, webhooks: body.webhooks.map((w) => ({ ...w, id: "…" })) }).toEqual({
      ok: true,
      adguard: "ok",
      off: ["MacBook Pro"],
      webhooks: [
        { id: "…", name: "Bot", ok: true },
        { id: "…", name: "Slack", ok: true },
      ],
    });
    const text = "Test from AdGuard Protection Watch: this webhook works, and AdGuard DNS protection is off for MacBook Pro.";
    expect(world.webhooks.map(({ url, payload }) => ({ url, payload }))).toEqual([
      { url: "https://bot.test/hook", payload: { event: "test", message: text } },
      { url: "https://bot2.test/x", payload: { text } },
    ]);
    expect(await stored()).toBeNull();
    expect(world.puts).toEqual([]);
  });

  it("answers 502 and names what failed when a webhook or AdGuard fails", async () => {
    world.webhookResponse = "500";
    world.adguardDown = true;
    const res = await admin("POST", "/webhooks/test");
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      ok: false,
      adguard: "GET /v2/dns_servers: HTTP 503",
      off: null,
      webhooks: [{ name: "Bot", ok: false, error: "HTTP 500" }],
    });
    expect(world.webhooks[0]!.payload.message).toContain("could not read AdGuard DNS");
  });

  it("needs the token, and answers 409 with no webhooks", async () => {
    expect((await admin("POST", "/webhooks/test", {})).status).toBe(401);
    const [hook] = await (await admin("GET", "/webhooks")).json<{ id: string }[]>();
    await admin("DELETE", `/webhooks/${hook!.id}`);
    expect((await admin("POST", "/webhooks/test")).status).toBe(409);
  });
});

describe("message formats", () => {
  it.each([
    ["slack", "application/json", (text: string) => ({ text })],
    ["discord", "application/json", (text: string) => ({ content: text })],
    ["text", "text/plain; charset=utf-8", (text: string) => text],
  ] as const)("sends a %s reminder with a link to snooze or turn on", async (format, contentType, shape) => {
    await register({ name: format, url: "https://bot2.test/x", format });
    world.webhooks = [];
    world.setOff("d1");
    await checkAt(0);
    await checkAt(60);
    const code = (await stored())?.snoozeCode;
    const sent = world.webhooks.find((w) => w.url === "https://bot2.test/x")!;
    expect(sent.contentType).toBe(contentType);
    expect(sent.payload).toEqual(
      shape(
        `AdGuard DNS protection is off for MacBook Pro (1h). It turns back on automatically in ~5 min. Snooze or turn it on: https://watch.test/snooze?code=${code}`,
      ),
    );
  });
});

describe("turn on from the reminder", () => {
  it("turns protection on, clears the reminder, and makes the code stop working", async () => {
    const reminder = await remindedFromMinute0();
    const res = await request(62, "POST", reminder.turn_on.url);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, turned_on: ["MacBook Pro"] });
    expect(world.isOn("d1")).toBe(true);
    expect(await stored()).toBeNull();
    expect((await request(63, "POST", reminder.turn_on.url)).status).toBe(410);
    expect((await request(63, "POST", reminder.snooze.url)).status).toBe(410);
    await checkAt(65);
    expect(events()).toEqual(["reminder"]);
  });

  it("refuses a wrong code (404) and a code with no pending reminder (410)", async () => {
    await remindedFromMinute0();
    expect((await request(62, "POST", "https://watch.test/turn-on?code=wrong")).status).toBe(404);
    expect(world.puts).toEqual([]);
    world.setOff("d1", false);
    await checkAt(63);
    expect((await request(63, "POST", "https://watch.test/turn-on?code=anything")).status).toBe(410);
  });

  it("keeps the reminder when a switch fails to turn on, so the auto turn-on retries it", async () => {
    world.setOff("d2");
    world.failingPuts.add("d1");
    const reminder = await remindedFromMinute0();
    const res = await request(62, "POST", reminder.turn_on.url);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, turned_on: ["iPhone"], failed: ["MacBook Pro"] });
    expect(await stored()).toMatchObject({ phase: "reminded" });
    world.failingPuts.clear();
    await checkAt(65);
    expect(world.isOn("d1")).toBe(true);
  });

  it("answers 502 and leaves the reminder when AdGuard is down", async () => {
    const reminder = await remindedFromMinute0();
    world.adguardDown = true;
    expect((await request(62, "POST", reminder.turn_on.url)).status).toBe(502);
    expect(await stored()).toMatchObject({ phase: "reminded" });
  });

  it("shows a turn-on button on the reminder page, and the button's POST turns protection on", async () => {
    const reminder = await remindedFromMinute0();
    const page = await (await request(62, "GET", reminder.snooze.url)).text();
    const code = encodeURIComponent((await stored())!.snoozeCode as string);
    expect(page).toContain(`<form method="post" action="/turn-on?code=${code}">`);
    const res = await request(62, "POST", reminder.turn_on.url, { body: new URLSearchParams() });
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("MacBook Pro");
    expect(world.isOn("d1")).toBe(true);
  });
});
