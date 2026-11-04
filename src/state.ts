import type { Watch } from "./domain";

const KEY = "state";

export type Stored = { raw: string | null; watch: Watch | null };

export async function readWatch(kv: KVNamespace): Promise<Stored> {
  const raw = await kv.get(KEY);
  return { raw, watch: raw === null ? null : parseWatch(raw) };
}

// Free-plan KV allows 1,000 writes a day and the cron runs 288 times, so only write changes.
export async function saveWatch(kv: KVNamespace, prev: Stored, next: Watch | null): Promise<void> {
  const value = next === null ? null : JSON.stringify(next);
  if (value === prev.raw) return;
  if (value === null) await kv.delete(KEY);
  else await kv.put(KEY, value);
}

function parseWatch(raw: string): Watch {
  const v: unknown = JSON.parse(raw);
  if (typeof v === "object" && v !== null && "phase" in v && "offSince" in v && isTime(v.offSince)) {
    const { phase, offSince } = v;
    if (phase === "off") return { phase, offSince };
    if (phase === "reminded" && "remindedAt" in v && isTime(v.remindedAt) && "snoozeCode" in v && typeof v.snoozeCode === "string") {
      return { phase, offSince, remindedAt: v.remindedAt, snoozeCode: v.snoozeCode };
    }
    if (phase === "snoozed" && "snoozeUntil" in v && isTime(v.snoozeUntil)) {
      return { phase, offSince, snoozeUntil: v.snoozeUntil };
    }
  }
  throw new Error(`stored state is not a valid watch: ${raw}`);
}

function isTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
