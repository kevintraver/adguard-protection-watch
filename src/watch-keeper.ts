import { DurableObject } from "cloudflare:workers";
import { applySnooze, decide, type SnoozeResult, type Switch, type Watch } from "./domain";
import type { Settings } from "./config";
import { enableAll } from "./adguard";
import { autoEnabledPayload, notify, reminderPayload, type Payload } from "./webhook";

const KEY = "watch";

export class WatchKeeper extends DurableObject<Env> {
  async check(settings: Settings, off: Switch[], now: number): Promise<void> {
    // Snoozes wait for the turn-on PUTs, so none can succeed for a reminder that is about to be cleared.
    // A throw inside the block would reset the object, so the error is rethrown after it.
    const outcome = await this.ctx.blockConcurrencyWhile(() =>
      transition(this.ctx.storage.kv, settings, off, now).then(
        (payload) => ({ payload }),
        (error: unknown) => ({ error }),
      ),
    );
    if ("error" in outcome) throw outcome.error;
    if (outcome.payload) await notify(settings.webhook, outcome.payload);
  }

  snooze(code: string | null, minutes: number, now: number): SnoozeResult {
    const result = applySnooze(read(this.ctx.storage.kv), code, minutes, now);
    if (result.type === "ok") save(this.ctx.storage.kv, result.next);
    return result;
  }

  watch(): Watch | null {
    return read(this.ctx.storage.kv);
  }
}

async function transition(kv: SyncKvStorage, settings: Settings, off: Switch[], now: number): Promise<Payload | null> {
  const { next, effect } = decide(read(kv), off, now, settings.timing, crypto.randomUUID());
  if (effect?.type !== "turnOn") {
    save(kv, next);
    return effect && reminderPayload(effect, now, settings);
  }
  const turnedOn = await enableAll(settings.adguard, effect.off);
  // A switch that failed to turn on keeps the overdue reminder, so the next check retries it.
  if (turnedOn.length === effect.off.length) save(kv, next);
  return turnedOn.length > 0 ? autoEnabledPayload(turnedOn, effect.offSince, "no_reply") : null;
}

function read(kv: SyncKvStorage): Watch | null {
  const value = kv.get(KEY);
  return value === undefined ? null : parseWatch(value);
}

function save(kv: SyncKvStorage, next: Watch | null): void {
  if (next === null) kv.delete(KEY);
  else kv.put(KEY, next);
}

function parseWatch(v: unknown): Watch {
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
  throw new Error(`stored state is not a valid watch: ${JSON.stringify(v)}`);
}

function isTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
