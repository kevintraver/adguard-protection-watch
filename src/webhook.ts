import { MINUTE, type Effect, type Switch } from "./domain";
import type { Settings } from "./config";

export const FORMATS = ["json", "slack", "discord", "text"] as const;
export type Format = (typeof FORMATS)[number];

export type Webhook = {
  id: string;
  name: string;
  url: string;
  headers: Record<string, string>;
  format: Format;
  addedAt: number;
};

export type WebhookInput = Omit<Webhook, "id" | "addedAt">;

type OffItem = Pick<Switch, "kind" | "id" | "name">;
type Link = { method: "POST"; url: string };

export type Payload =
  | {
      event: "reminder";
      message: string;
      off_since: string;
      auto_enable_at: string;
      off: OffItem[];
      snooze?: Link & { params: { minutes: string } };
      turn_on?: Link;
    }
  | { event: "auto_enabled"; message: string; off_since?: string; off: OffItem[] }
  | { event: "test"; message: string };

/** `payload` goes to `json` webhooks; `text` is the same news for people reading it in a chat app. */
export type Message = { payload: Payload; text: string };

export function reminderMessage(
  effect: Extract<Effect, { type: "remind" }>,
  now: number,
  settings: Settings,
): Message {
  const status = `AdGuard DNS protection is off for ${describe(effect.off)} (${duration(now - effect.offSince)}).`;
  const deadline = `It turns back on automatically in ~${duration(effect.autoEnableAt - now)}.`;
  const payload: Payload = {
    event: "reminder",
    message: `${status} Reply "snooze" (or "snooze 20m") or "turn on". ${deadline}`,
    off_since: iso(effect.offSince),
    auto_enable_at: iso(effect.autoEnableAt),
    off: effect.off.map(offItem),
  };
  if (!settings.publicUrl) return { payload, text: `${status} ${deadline}` };

  const link = (path: string) => {
    const url = new URL(path, settings.publicUrl!);
    url.searchParams.set("code", effect.snoozeCode);
    return url.href;
  };
  payload.snooze = {
    method: "POST",
    url: link("/snooze"),
    params: { minutes: `integer, default ${settings.timing.defaultSnoozeMin}` },
  };
  payload.turn_on = { method: "POST", url: link("/turn-on") };
  return { payload, text: `${status} ${deadline} Snooze or turn it on: ${payload.snooze.url}` };
}

export function autoEnabledMessage(
  turnedOn: Switch[],
  offSince: number | null,
  reason: "no_reply" | "error",
): Message {
  const why = reason === "no_reply" ? "No reply" : "The protection check hit an error";
  const message = `${why}, so AdGuard DNS protection is back on for ${describe(turnedOn)}.`;
  return {
    payload: {
      event: "auto_enabled",
      message,
      ...(offSince === null ? {} : { off_since: iso(offSince) }),
      off: turnedOn.map(offItem),
    },
    text: message,
  };
}

/** The on-demand check: says what the Worker can see in AdGuard right now. */
export function checkMessage(off: Switch[] | null): Message {
  const status =
    off === null
      ? "but it could not read AdGuard DNS (see the Worker logs)"
      : off.length === 0
        ? "and AdGuard DNS protection is on everywhere"
        : `and AdGuard DNS protection is off for ${describe(off)}`;
  const message = `Test from AdGuard Protection Watch: this webhook works, ${status}.`;
  return { payload: { event: "test", message }, text: message };
}

export function testMessage(name: string): Message {
  const message = `AdGuard Protection Watch will send its reminders for "${name}" here.`;
  return { payload: { event: "test", message }, text: message };
}

/** Sends to every webhook at once. A failure is logged and never thrown, so one broken webhook can't block the rest. */
export async function notify(webhooks: Webhook[], message: Message): Promise<void> {
  if (webhooks.length === 0) {
    console.warn(`No webhooks are registered, so the ${message.payload.event} message was not sent`);
    return;
  }
  await Promise.all(
    webhooks.map(async (webhook) => {
      const error = await send(webhook, message);
      if (error) console.error(`${message.payload.event} webhook "${webhook.name}" failed: ${error}`);
    }),
  );
}

/** Returns why the send failed, or null when the webhook answered with a 2xx. */
export async function send(webhook: Pick<Webhook, "url" | "headers" | "format">, message: Message): Promise<string | null> {
  const { body, contentType } = render(webhook.format, message);
  try {
    const res = await fetch(webhook.url, {
      method: "POST",
      headers: { ...webhook.headers, "Content-Type": contentType },
      body,
    });
    return res.ok ? null : `HTTP ${res.status}`;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function render(format: Format, { payload, text }: Message): { body: string; contentType: string } {
  switch (format) {
    case "json":
      return { body: JSON.stringify(payload), contentType: "application/json" };
    case "slack":
      return { body: JSON.stringify({ text }), contentType: "application/json" };
    case "discord":
      return { body: JSON.stringify({ content: text }), contentType: "application/json" };
    case "text":
      return { body: text, contentType: "text/plain; charset=utf-8" };
  }
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseWebhookInput(raw: unknown): Parsed<WebhookInput> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return fail("body must be a JSON object");
  const body = raw as Record<string, unknown>;

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length < 1 || name.length > 100) return fail("name must be 1 to 100 characters");

  if (typeof body.url !== "string" || !URL.canParse(body.url) || new URL(body.url).protocol !== "https:") {
    return fail("url must be an https URL");
  }

  const format = body.format ?? "json";
  if (!FORMATS.includes(format as Format)) return fail(`format must be one of ${FORMATS.join(", ")}`);

  const headers = parseHeaders(body.headers ?? {});
  if (!headers.ok) return headers;

  return { ok: true, value: { name, url: body.url, headers: headers.value, format: format as Format } };
}

/** Rebuilds a webhook read back from storage, so a corrupt entry fails loudly instead of sending somewhere odd. */
export function parseStoredWebhook(raw: unknown): Webhook {
  const input = parseWebhookInput(raw);
  const stored = raw as Record<string, unknown>;
  if (!input.ok || typeof stored.id !== "string" || typeof stored.addedAt !== "number") {
    throw new Error(`stored webhook is not valid: ${input.ok ? "missing id or addedAt" : input.error}`);
  }
  return { id: stored.id, addedAt: stored.addedAt, ...input.value };
}

export function publicView({ id, name, url, format, headers, addedAt }: Webhook) {
  return { id, name, host: new URL(url).host, format, header_names: Object.keys(headers), added_at: iso(addedAt) };
}

function parseHeaders(raw: unknown): Parsed<Record<string, string>> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return fail("headers must be an object of strings");
  const entries = Object.entries(raw);
  if (entries.length > 20) return fail("at most 20 headers");
  if (entries.some(([, value]) => typeof value !== "string")) return fail("headers must be an object of strings");
  try {
    new Headers(entries as [string, string][]);
  } catch {
    return fail("headers contain an invalid name or value");
  }
  return { ok: true, value: Object.fromEntries(entries) as Record<string, string> };
}

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function describe(off: Switch[]): string {
  const names = off.map((s) => (s.kind === "server" ? `all devices on ${s.name}` : s.name));
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function duration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / MINUTE));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest} min`;
}

function offItem({ kind, id, name }: Switch): OffItem {
  return { kind, id, name };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}
