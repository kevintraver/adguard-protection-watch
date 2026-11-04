import { MINUTE, type Effect, type Switch } from "./domain";
import type { Settings } from "./config";

type OffItem = Pick<Switch, "kind" | "id" | "name">;

export type Payload =
  | {
      event: "reminder";
      message: string;
      off_since: string;
      auto_enable_at: string;
      off: OffItem[];
      snooze?: { method: "POST"; url: string; params: { minutes: string } };
    }
  | { event: "auto_enabled"; message: string; off_since?: string; off: OffItem[] };

export function reminderPayload(
  effect: Extract<Effect, { type: "remind" }>,
  now: number,
  settings: Settings,
): Payload {
  const payload: Payload = {
    event: "reminder",
    message:
      `AdGuard DNS protection is off for ${describe(effect.off)} (${duration(now - effect.offSince)}). ` +
      `Reply "snooze" (or "snooze 20m") or "turn on". ` +
      `It turns back on automatically in ~${duration(effect.autoEnableAt - now)}.`,
    off_since: iso(effect.offSince),
    auto_enable_at: iso(effect.autoEnableAt),
    off: effect.off.map(offItem),
  };
  if (settings.publicUrl) {
    const url = new URL("/snooze", settings.publicUrl);
    url.searchParams.set("code", effect.snoozeCode);
    payload.snooze = {
      method: "POST",
      url: url.href,
      params: { minutes: `integer, default ${settings.timing.defaultSnoozeMin}` },
    };
  }
  return payload;
}

export function autoEnabledPayload(
  turnedOn: Switch[],
  offSince: number | null,
  reason: "no_reply" | "error",
): Payload {
  const why = reason === "no_reply" ? "No reply" : "The protection check hit an error";
  return {
    event: "auto_enabled",
    message: `${why}, so AdGuard DNS protection is back on for ${describe(turnedOn)}.`,
    ...(offSince === null ? {} : { off_since: iso(offSince) }),
    off: turnedOn.map(offItem),
  };
}

export async function notify(webhook: Settings["webhook"], payload: Payload): Promise<void> {
  if (webhook.urls.length === 0) {
    console.warn(`WEBHOOK_URLS is empty, so the ${payload.event} webhook was not sent`);
    return;
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (webhook.auth) headers.Authorization = webhook.auth;
  const body = JSON.stringify(payload);
  await Promise.all(
    webhook.urls.map(async (url, i) => {
      try {
        const res = await fetch(url, { method: "POST", headers, body });
        if (!res.ok) console.error(`${payload.event} webhook #${i + 1} returned HTTP ${res.status}`);
      } catch (err) {
        console.error(`${payload.event} webhook #${i + 1} failed`, err);
      }
    }),
  );
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
