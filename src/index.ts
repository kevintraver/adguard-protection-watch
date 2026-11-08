import { checkCode, type Switch } from "./domain";
import { parseMinutes, parseSettings, type Settings } from "./config";
import { enableAll, readSwitches } from "./adguard";
import { autoEnabledMessage, checkMessage, notify, parseWebhookInput, publicView, send, testMessage, type Webhook } from "./webhook";
import type { WatchKeeper } from "./watch-keeper";

export { WatchKeeper } from "./watch-keeper";

type Keeper = DurableObjectStub<WatchKeeper>;

export default {
  async scheduled(controller, env) {
    await check(parseSettings(env), keeper(env), controller.scheduledTime);
  },
  async fetch(request: Request, env: Env) {
    return route(request, parseSettings(env), keeper(env), Date.now());
  },
} satisfies ExportedHandler<Env>;

function keeper(env: Env): Keeper {
  return env.WATCH.getByName("watch");
}

async function check(settings: Settings, keeper: Keeper, now: number): Promise<void> {
  let off: Switch[];
  try {
    off = (await readSwitches(settings.adguard)).filter((s) => !s.enabled);
  } catch (err) {
    console.error("Could not read AdGuard protection; trying again at the next check", err);
    return;
  }

  try {
    await keeper.check(settings, off, now);
  } catch (err) {
    console.error("Protection check failed; turning on every switch that is off", err);
    const turnedOn = await enableAll(settings.adguard, off);
    if (turnedOn.length > 0) await notify(await webhooksOrNone(keeper), autoEnabledMessage(turnedOn, null, "error"));
  }
}

async function webhooksOrNone(keeper: Keeper): Promise<Webhook[]> {
  try {
    return await keeper.webhooksOrNone();
  } catch (err) {
    console.error("Could not reach the webhook list, so no message was sent", err);
    return [];
  }
}

async function route(request: Request, settings: Settings, keeper: Keeper, now: number): Promise<Response> {
  const url = new URL(request.url);
  const { method } = request;
  if (url.pathname === "/" && method === "GET") return new Response("ok");
  if (url.pathname === "/snooze" && method === "GET") return reminderPage(url, settings, keeper);
  if (url.pathname === "/snooze" && method === "POST") return snooze(request, url, settings, keeper, now);
  if (url.pathname === "/turn-on" && method === "POST") return turnOn(request, url, settings, keeper);
  if (url.pathname === "/webhooks" || url.pathname.startsWith("/webhooks/")) {
    return webhooks(request, url, settings, keeper, now);
  }
  return new Response("Not found", { status: 404 });
}

async function reminderPage(url: URL, settings: Settings, keeper: Keeper): Promise<Response> {
  const code = url.searchParams.get("code");
  const checked = checkCode(await keeper.watch(), code);
  if (checked.type !== "ok") return rejection(checked.type);
  const turnOnUrl = `/turn-on?code=${encodeURIComponent(code ?? "")}`;
  return html(
    `<h1>AdGuard DNS protection is off</h1>
<form method="post" action="${turnOnUrl}">
  <button>Turn protection on now</button>
</form>
<h2>Or snooze the reminder</h2>
<form method="post">
  <label>Minutes <input name="minutes" type="number" min="1" step="1" value="${settings.timing.defaultSnoozeMin}" required></label>
  <button>Snooze</button>
</form>`,
  );
}

async function snooze(request: Request, url: URL, settings: Settings, keeper: Keeper, now: number): Promise<Response> {
  const fromForm = isForm(request);
  const rawMinutes = fromForm ? (await request.formData()).get("minutes") : url.searchParams.get("minutes");
  const minutes = rawMinutes === null ? settings.timing.defaultSnoozeMin : parseMinutes(rawMinutes);
  if (minutes === null) return new Response("minutes must be a whole number of at least 1", { status: 400 });

  const result = await keeper.snooze(url.searchParams.get("code"), minutes, now);
  if (result.type !== "ok") return rejection(result.type);

  if (fromForm) return html(`<h1>Snoozed for ${minutes} min</h1><p>If protection is still off after that, you'll get a new reminder.</p>`);
  return Response.json({ ok: true, snooze_until: new Date(result.next.snoozeUntil).toISOString() });
}

async function turnOn(request: Request, url: URL, settings: Settings, keeper: Keeper): Promise<Response> {
  let result;
  try {
    result = await keeper.turnOn(settings, url.searchParams.get("code"));
  } catch (err) {
    console.error("Turn on from the reminder link failed", err);
    return new Response("Could not reach AdGuard. Protection turns on automatically when the reminder runs out.", {
      status: 502,
    });
  }
  if (result.type === "no_pending" || result.type === "bad_code") return rejection(result.type);

  const names = (switches: Switch[]) => switches.map((s) => s.name);
  if (isForm(request)) {
    return result.type === "ok"
      ? html(`<h1>Protection is on</h1><p>${escape(names(result.turnedOn).join(", ") || "Everything was already on.")}</p>`)
      : html(`<h1>Some switches didn't turn on</h1><p>${escape(names(result.failed).join(", "))} will be retried automatically.</p>`, 502);
  }
  return result.type === "ok"
    ? Response.json({ ok: true, turned_on: names(result.turnedOn) })
    : Response.json({ ok: false, turned_on: names(result.turnedOn), failed: names(result.failed) }, { status: 502 });
}

async function webhooks(request: Request, url: URL, settings: Settings, keeper: Keeper, now: number): Promise<Response> {
  // Without a token the endpoints don't exist, rather than being open to anyone.
  if (!settings.adminToken) return new Response("Not found", { status: 404 });
  if (!authorized(request, settings.adminToken)) return new Response("Unauthorized", { status: 401 });

  const id = url.pathname.startsWith("/webhooks/") ? url.pathname.slice("/webhooks/".length) : null;

  if (id === null && request.method === "GET") return Response.json((await keeper.webhooks()).map(publicView));

  if (id === null && request.method === "POST") {
    const parsed = parseWebhookInput(await request.json().catch(() => null));
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
    const error = await send(parsed.value, testMessage(parsed.value.name));
    if (error) return Response.json({ error: `the test message failed: ${error}` }, { status: 422 });
    const saved = await keeper.saveWebhook(parsed.value, now);
    if (saved.type === "full") return Response.json({ error: "too many webhooks; remove one first" }, { status: 409 });
    return Response.json(publicView(saved.webhook), { status: saved.created ? 201 : 200 });
  }

  if (id === "test" && request.method === "POST") return testAll(settings, keeper);

  if (id !== null && request.method === "DELETE") {
    return (await keeper.removeWebhook(id)) ? new Response(null, { status: 204 }) : new Response("Not found", { status: 404 });
  }

  return new Response("Not found", { status: 404 });
}

/** Checks the whole path on demand: the AdGuard key, then every webhook with its own headers. */
async function testAll(settings: Settings, keeper: Keeper): Promise<Response> {
  const list = await keeper.webhooks();
  if (list.length === 0) return Response.json({ error: "no webhooks are registered" }, { status: 409 });

  let off: Switch[] | null = null;
  let adguard = "ok";
  try {
    off = (await readSwitches(settings.adguard)).filter((s) => !s.enabled);
  } catch (err) {
    console.error("Test: could not read AdGuard protection", err);
    adguard = err instanceof Error ? err.message : String(err);
  }

  const message = checkMessage(off);
  const webhooks = await Promise.all(
    list.map(async (webhook) => {
      const error = await send(webhook, message);
      return { id: webhook.id, name: webhook.name, ...(error ? { ok: false, error } : { ok: true }) };
    }),
  );
  const ok = adguard === "ok" && webhooks.every((w) => w.ok);
  return Response.json(
    { ok, adguard, off: off?.map((s) => s.name) ?? null, webhooks },
    { status: ok ? 200 : 502 },
  );
}

function authorized(request: Request, token: string): boolean {
  const encoder = new TextEncoder();
  const given = encoder.encode(request.headers.get("authorization") ?? "");
  const expected = encoder.encode(`Bearer ${token}`);
  return given.byteLength === expected.byteLength && crypto.subtle.timingSafeEqual(given, expected);
}

function isForm(request: Request): boolean {
  return request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded") ?? false;
}

function rejection(type: "no_pending" | "bad_code"): Response {
  return type === "no_pending"
    ? new Response("No reminder is pending", { status: 410 })
    : new Response("Unknown snooze code", { status: 404 });
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function html(body: string, status = 200): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>AdGuard Protection Watch</title>
<style>body { font: 16px/1.5 system-ui, sans-serif; max-width: 26rem; margin: 3rem auto; padding: 0 1rem } form { margin: 1rem 0 }</style>
${body}`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}
