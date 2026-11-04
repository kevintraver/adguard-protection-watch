import { describe, expect, it } from "vitest";
import { applySnooze, decide, type Config, type Switch, type Watch } from "../src/domain";

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 4, 19, 2);
const config: Config = { remindAfterMin: 60, autoEnableAfterMin: 5, defaultSnoozeMin: 60 };

const laptop: Switch = { kind: "device", id: "d1", name: "MacBook Pro", enabled: false };
const phone: Switch = { kind: "device", id: "d2", name: "iPhone", enabled: false };
const server: Switch = { kind: "server", id: "srv1", name: "Home", enabled: false };

describe("decide", () => {
  it("does nothing while everything is on and nothing is stored", () => {
    expect(decide(null, [], T0, config, "c1")).toEqual({ next: null, effect: null });
  });

  it.each<Watch>([
    { phase: "off", offSince: T0 },
    { phase: "reminded", offSince: T0, remindedAt: T0 + 60 * MIN, snoozeCode: "c0" },
    { phase: "snoozed", offSince: T0, snoozeUntil: T0 + 600 * MIN },
  ])("clears the state once everything is back on ($phase)", (watch) => {
    expect(decide(watch, [], T0 + 61 * MIN, config, "c1")).toEqual({ next: null, effect: null });
  });

  it("starts the timer the first time something is off", () => {
    expect(decide(null, [laptop], T0, config, "c1")).toEqual({
      next: { phase: "off", offSince: T0 },
      effect: null,
    });
  });

  it("waits while protection has been off for less than an hour", () => {
    const watch: Watch = { phase: "off", offSince: T0 };
    expect(decide(watch, [laptop], T0 + 59 * MIN, config, "c1")).toEqual({ next: watch, effect: null });
  });

  it("reminds once protection has been off for an hour, naming what is off", () => {
    const now = T0 + 60 * MIN;
    expect(decide({ phase: "off", offSince: T0 }, [laptop], now, config, "c1")).toEqual({
      next: { phase: "reminded", offSince: T0, remindedAt: now, snoozeCode: "c1" },
      effect: { type: "remind", off: [laptop], offSince: T0, autoEnableAt: now + 5 * MIN, snoozeCode: "c1" },
    });
  });

  it("uses the configured reminder delay", () => {
    const fast = { ...config, remindAfterMin: 5 };
    const watch: Watch = { phase: "off", offSince: T0 };
    expect(decide(watch, [laptop], T0 + 4 * MIN, fast, "c1").effect).toBeNull();
    expect(decide(watch, [laptop], T0 + 5 * MIN, fast, "c1").effect?.type).toBe("remind");
  });

  it("keeps the first off_since when a second switch goes off, and lists both", () => {
    const watch: Watch = { phase: "off", offSince: T0 };
    expect(decide(watch, [laptop, phone], T0 + 50 * MIN, config, "c1")).toEqual({ next: watch, effect: null });
    const { effect } = decide(watch, [laptop, phone], T0 + 60 * MIN, config, "c1");
    expect(effect).toMatchObject({ type: "remind", off: [laptop, phone], offSince: T0 });
  });

  it("keeps the timer running when one switch comes back on and another stays off", () => {
    const watch: Watch = { phase: "off", offSince: T0 };
    const { next, effect } = decide(watch, [phone], T0 + 60 * MIN, config, "c1");
    expect(next).toMatchObject({ phase: "reminded", offSince: T0 });
    expect(effect).toMatchObject({ type: "remind", off: [phone] });
  });

  it("waits for a reply for less than 5 minutes after a reminder", () => {
    const watch: Watch = { phase: "reminded", offSince: T0, remindedAt: T0 + 60 * MIN, snoozeCode: "c0" };
    expect(decide(watch, [laptop], T0 + 64 * MIN, config, "c1")).toEqual({ next: watch, effect: null });
  });

  it("turns on every switch that is off now once a reminder goes unanswered for 5 minutes", () => {
    const watch: Watch = { phase: "reminded", offSince: T0, remindedAt: T0 + 60 * MIN, snoozeCode: "c0" };
    expect(decide(watch, [server, phone], T0 + 65 * MIN, config, "c1")).toEqual({
      next: null,
      effect: { type: "turnOn", off: [server, phone], offSince: T0 },
    });
  });

  it("stays quiet during a snooze, even with a new switch off, then reminds when it ends", () => {
    const watch: Watch = { phase: "snoozed", offSince: T0, snoozeUntil: T0 + 200 * MIN };
    expect(decide(watch, [laptop, phone], T0 + 199 * MIN, config, "c1")).toEqual({ next: watch, effect: null });

    const now = T0 + 200 * MIN;
    expect(decide(watch, [laptop, phone], now, config, "c2")).toEqual({
      next: { phase: "reminded", offSince: T0, remindedAt: now, snoozeCode: "c2" },
      effect: { type: "remind", off: [laptop, phone], offSince: T0, autoEnableAt: now + 5 * MIN, snoozeCode: "c2" },
    });
  });
});

describe("applySnooze", () => {
  const reminded: Watch = { phase: "reminded", offSince: T0, remindedAt: T0 + 60 * MIN, snoozeCode: "c1" };
  const now = T0 + 62 * MIN;

  it("snoozes for the requested minutes and retires the code", () => {
    expect(applySnooze(reminded, "c1", 20, now)).toEqual({
      type: "ok",
      next: { phase: "snoozed", offSince: T0, snoozeUntil: now + 20 * MIN },
    });
  });

  it("accepts a very long snooze", () => {
    const result = applySnooze(reminded, "c1", 10_000, now);
    expect(result).toEqual({
      type: "ok",
      next: { phase: "snoozed", offSince: T0, snoozeUntil: now + 10_000 * MIN },
    });
  });

  it.each([["wrong"], [null]])("rejects code %s while a reminder is pending", (code) => {
    expect(applySnooze(reminded, code, 20, now)).toEqual({ type: "bad_code" });
  });

  it.each<[string, Watch | null]>([
    ["nothing is off", null],
    ["no reminder was sent yet", { phase: "off", offSince: T0 }],
    ["the code was already used", { phase: "snoozed", offSince: T0, snoozeUntil: now + 60 * MIN }],
  ])("reports no pending reminder when %s", (_, watch) => {
    expect(applySnooze(watch, "c1", 20, now)).toEqual({ type: "no_pending" });
  });
});
