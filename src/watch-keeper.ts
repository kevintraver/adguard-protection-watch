import { DurableObject } from "cloudflare:workers";
import { applySnooze, checkCode, decide, type SnoozeResult, type Switch, type Watch } from "./domain";
import type { Settings } from "./config";
import { enableAll, readSwitches } from "./adguard";
import {
  autoEnabledMessage,
  notify,
  parseStoredWebhook,
  reminderMessage,
  type Message,
  type Webhook,
  type WebhookInput,
} from "./webhook";

const WATCH = "watch";
const WEBHOOKS = "webhooks";
export const MAX_WEBHOOKS = 20;

export type TurnOnResult =
  | { type: "ok"; turnedOn: Switch[] }
  | { type: "partial"; turnedOn: Switch[]; failed: Switch[] }
  | { type: "no_pending" }
  | { type: "bad_code" };

export type SaveResult = { type: "ok"; webhook: Webhook; created: boolean } | { type: "full" };

export class WatchKeeper extends DurableObject<Env> {
  async check(settings: Settings, off: Switch[], now: number): Promise<void> {
    // Snoozes wait for the turn-on PUTs, so none can succeed for a reminder that is about to be cleared.
    const message = await this.exclusive(() => transition(this.ctx.storage.kv, settings, off, now));
    if (message) await notify(this.webhooksOrNone(), message);
  }

  snooze(code: string | null, minutes: number, now: number): SnoozeResult {
    const result = applySnooze(read(this.ctx.storage.kv), code, minutes, now);
    if (result.type === "ok") save(this.ctx.storage.kv, result.next);
    return result;
  }

  /** "Turn on now" from a reminder's link: the same one-time code as a snooze. */
  turnOn(settings: Settings, code: string | null): Promise<TurnOnResult> {
    return this.exclusive(async () => {
      const kv = this.ctx.storage.kv;
      const checked = checkCode(read(kv), code);
      if (checked.type !== "ok") return checked;
      const off = (await readSwitches(settings.adguard)).filter((s) => !s.enabled);
      const turnedOn = await enableAll(settings.adguard, off);
      if (turnedOn.length < off.length) {
        // The reminder stays, so its auto turn-on still retries the rest.
        return { type: "partial", turnedOn, failed: off.filter((s) => !turnedOn.includes(s)) };
      }
      save(kv, null);
      return { type: "ok", turnedOn };
    });
  }

  watch(): Watch | null {
    return read(this.ctx.storage.kv);
  }

  webhooks(): Webhook[] {
    const value = this.ctx.storage.kv.get(WEBHOOKS);
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error("stored webhooks are not a list");
    return value.map(parseStoredWebhook);
  }

  /** Adds a webhook, or replaces the one with the same URL so a bot can register again safely. */
  saveWebhook(input: WebhookInput, now: number): SaveResult {
    const webhooks = this.webhooks();
    const existing = webhooks.find((w) => w.url === input.url);
    if (!existing && webhooks.length >= MAX_WEBHOOKS) return { type: "full" };
    const webhook: Webhook = existing
      ? { ...input, id: existing.id, addedAt: existing.addedAt }
      : { ...input, id: crypto.randomUUID(), addedAt: now };
    const next = existing ? webhooks.map((w) => (w.id === existing.id ? webhook : w)) : [...webhooks, webhook];
    this.ctx.storage.kv.put(WEBHOOKS, next);
    return { type: "ok", webhook, created: !existing };
  }

  removeWebhook(id: string): boolean {
    const webhooks = this.webhooks();
    const next = webhooks.filter((w) => w.id !== id);
    if (next.length === webhooks.length) return false;
    this.ctx.storage.kv.put(WEBHOOKS, next);
    return true;
  }

  /** A broken webhook list must not stop a reminder's state from being saved; the auto turn-on still follows. */
  webhooksOrNone(): Webhook[] {
    try {
      return this.webhooks();
    } catch (err) {
      console.error("Could not read the webhook list, so no message was sent", err);
      return [];
    }
  }

  // A throw inside blockConcurrencyWhile would reset the object, so the error is rethrown after it.
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const outcome = await this.ctx.blockConcurrencyWhile(() =>
      fn().then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      ),
    );
    if ("error" in outcome) throw outcome.error;
    return outcome.value;
  }
}

async function transition(kv: SyncKvStorage, settings: Settings, off: Switch[], now: number): Promise<Message | null> {
  const { next, effect } = decide(read(kv), off, now, settings.timing, crypto.randomUUID());
  if (effect?.type !== "turnOn") {
    save(kv, next);
    return effect && reminderMessage(effect, now, settings);
  }
  const turnedOn = await enableAll(settings.adguard, effect.off);
  // A switch that failed to turn on keeps the overdue reminder, so the next check retries it.
  if (turnedOn.length === effect.off.length) save(kv, next);
  return turnedOn.length > 0 ? autoEnabledMessage(turnedOn, effect.offSince, "no_reply") : null;
}

function read(kv: SyncKvStorage): Watch | null {
  const value = kv.get(WATCH);
  return value === undefined ? null : parseWatch(value);
}

function save(kv: SyncKvStorage, next: Watch | null): void {
  if (next === null) kv.delete(WATCH);
  else kv.put(WATCH, next);
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
