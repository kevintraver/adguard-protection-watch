import { applySnooze, type Switch } from "./domain";
import { parseMinutes, parseSettings, type Settings } from "./config";
import { enableAll, readSwitches } from "./adguard";
import { autoEnabledPayload, notify } from "./webhook";
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
    if (turnedOn.length > 0) await notify(settings.webhook, autoEnabledPayload(turnedOn, null, "error"));
  }
}

async function route(request: Request, settings: Settings, keeper: Keeper, now: number): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/" && request.method === "GET") return new Response("ok");
  if (url.pathname !== "/snooze") return new Response("Not found", { status: 404 });
  if (request.method === "GET") return snoozePage(url, settings, keeper, now);
  if (request.method === "POST") return snooze(request, url, settings, keeper, now);
  return new Response("Not found", { status: 404 });
}

async function snoozePage(url: URL, settings: Settings, keeper: Keeper, now: number): Promise<Response> {
  const result = applySnooze(await keeper.watch(), url.searchParams.get("code"), settings.timing.defaultSnoozeMin, now);
  if (result.type !== "ok") return rejection(result.type);
  return html(
    `<h1>Snooze the AdGuard reminder</h1>
<form method="post">
  <label>Minutes <input name="minutes" type="number" min="1" step="1" value="${settings.timing.defaultSnoozeMin}" required></label>
  <button>Snooze</button>
</form>`,
  );
}

async function snooze(request: Request, url: URL, settings: Settings, keeper: Keeper, now: number): Promise<Response> {
  const fromForm = request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded") ?? false;
  const rawMinutes = fromForm ? (await request.formData()).get("minutes") : url.searchParams.get("minutes");
  const minutes = rawMinutes === null ? settings.timing.defaultSnoozeMin : parseMinutes(rawMinutes);
  if (minutes === null) return new Response("minutes must be a whole number of at least 1", { status: 400 });

  const result = await keeper.snooze(url.searchParams.get("code"), minutes, now);
  if (result.type !== "ok") return rejection(result.type);

  if (fromForm) return html(`<h1>Snoozed for ${minutes} min</h1><p>If protection is still off after that, you'll get a new reminder.</p>`);
  return Response.json({ ok: true, snooze_until: new Date(result.next.snoozeUntil).toISOString() });
}

function rejection(type: "no_pending" | "bad_code"): Response {
  return type === "no_pending"
    ? new Response("No reminder is pending", { status: 410 })
    : new Response("Unknown snooze code", { status: 404 });
}

function html(body: string): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>AdGuard Protection Watch</title>
<style>body { font: 16px/1.5 system-ui, sans-serif; max-width: 26rem; margin: 3rem auto; padding: 0 1rem }</style>
${body}`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}
