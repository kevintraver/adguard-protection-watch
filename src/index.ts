import { applySnooze, decide, type Switch } from "./domain";
import { parseMinutes, parseSettings, type Settings } from "./config";
import { enableProtection, readSwitches } from "./adguard";
import { readWatch, saveWatch } from "./state";
import { autoEnabledPayload, notify, reminderPayload } from "./webhook";

export default {
  async scheduled(controller, env) {
    await check(parseSettings(env), env.STATE, controller.scheduledTime);
  },
  async fetch(request: Request, env: Env) {
    return route(request, parseSettings(env), env.STATE, Date.now());
  },
} satisfies ExportedHandler<Env>;

async function check(settings: Settings, kv: KVNamespace, now: number): Promise<void> {
  let off: Switch[];
  try {
    off = (await readSwitches(settings.adguard)).filter((s) => !s.enabled);
  } catch (err) {
    console.error("Could not read AdGuard protection; trying again at the next check", err);
    return;
  }

  let offSince: number | null = null;
  try {
    const stored = await readWatch(kv);
    offSince = stored.watch?.offSince ?? null;
    const { next, effect } = decide(stored.watch, off, now, settings.timing, crypto.randomUUID());
    if (effect?.type === "turnOn") {
      // A switch that failed to turn on keeps the overdue reminder, so the next check retries it.
      if (await turnOn(settings, effect.off, effect.offSince, "no_reply")) await saveWatch(kv, stored, next);
      return;
    }
    await saveWatch(kv, stored, next);
    if (effect?.type === "remind") await notify(settings.webhook, reminderPayload(effect, now, settings));
  } catch (err) {
    console.error("Protection check failed; turning on every switch that is off", err);
    await turnOn(settings, off, offSince, "error");
  }
}

async function turnOn(
  settings: Settings,
  off: Switch[],
  offSince: number | null,
  reason: "no_reply" | "error",
): Promise<boolean> {
  if (off.length === 0) return true;
  const results = await Promise.allSettled(off.map((s) => enableProtection(settings.adguard, s)));
  const turnedOn = off.filter((s, i) => {
    const result = results[i];
    if (result?.status === "rejected") console.error(`Could not turn on protection for ${s.kind} ${s.id}`, result.reason);
    return result?.status === "fulfilled";
  });
  if (turnedOn.length > 0) await notify(settings.webhook, autoEnabledPayload(turnedOn, offSince, reason));
  return turnedOn.length === off.length;
}

async function route(request: Request, settings: Settings, kv: KVNamespace, now: number): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/" && request.method === "GET") return new Response("ok");
  if (url.pathname !== "/snooze") return new Response("Not found", { status: 404 });
  if (request.method === "GET") return snoozePage(url, settings, kv, now);
  if (request.method === "POST") return snooze(request, url, settings, kv, now);
  return new Response("Not found", { status: 404 });
}

async function snoozePage(url: URL, settings: Settings, kv: KVNamespace, now: number): Promise<Response> {
  const { watch } = await readWatch(kv);
  const result = applySnooze(watch, url.searchParams.get("code"), settings.timing.defaultSnoozeMin, now);
  if (result.type !== "ok") return rejection(result.type);
  return html(
    `<h1>Snooze the AdGuard reminder</h1>
<form method="post">
  <label>Minutes <input name="minutes" type="number" min="1" step="1" value="${settings.timing.defaultSnoozeMin}" required></label>
  <button>Snooze</button>
</form>`,
  );
}

async function snooze(request: Request, url: URL, settings: Settings, kv: KVNamespace, now: number): Promise<Response> {
  const fromForm = request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded") ?? false;
  const rawMinutes = fromForm ? (await request.formData()).get("minutes") : url.searchParams.get("minutes");
  const minutes = rawMinutes === null ? settings.timing.defaultSnoozeMin : parseMinutes(rawMinutes);
  if (minutes === null) return new Response("minutes must be a whole number of at least 1", { status: 400 });

  const stored = await readWatch(kv);
  const result = applySnooze(stored.watch, url.searchParams.get("code"), minutes, now);
  if (result.type !== "ok") return rejection(result.type);
  await saveWatch(kv, stored, result.next);

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
