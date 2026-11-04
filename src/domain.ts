export const MINUTE = 60_000;

export type Switch = {
  kind: "server" | "device";
  id: string;
  name: string;
  enabled: boolean;
};

export type Watch =
  | { phase: "off"; offSince: number }
  | { phase: "reminded"; offSince: number; remindedAt: number; snoozeCode: string }
  | { phase: "snoozed"; offSince: number; snoozeUntil: number };

export type Config = {
  remindAfterMin: number;
  autoEnableAfterMin: number;
  defaultSnoozeMin: number;
};

export type Effect =
  | { type: "remind"; off: Switch[]; offSince: number; autoEnableAt: number; snoozeCode: string }
  | { type: "turnOn"; off: Switch[]; offSince: number };

export type Decision = { next: Watch | null; effect: Effect | null };

export function decide(
  watch: Watch | null,
  off: Switch[],
  now: number,
  config: Config,
  newCode: string,
): Decision {
  if (off.length === 0) return { next: null, effect: null };
  if (watch === null) return { next: { phase: "off", offSince: now }, effect: null };

  const { offSince } = watch;
  const wait: Decision = { next: watch, effect: null };
  const remind: Decision = {
    next: { phase: "reminded", offSince, remindedAt: now, snoozeCode: newCode },
    effect: {
      type: "remind",
      off,
      offSince,
      autoEnableAt: now + config.autoEnableAfterMin * MINUTE,
      snoozeCode: newCode,
    },
  };

  switch (watch.phase) {
    case "off":
      return now >= offSince + config.remindAfterMin * MINUTE ? remind : wait;
    case "snoozed":
      return now >= watch.snoozeUntil ? remind : wait;
    case "reminded":
      return now >= watch.remindedAt + config.autoEnableAfterMin * MINUTE
        ? { next: null, effect: { type: "turnOn", off, offSince } }
        : wait;
  }
}

export type SnoozeResult =
  | { type: "ok"; next: Extract<Watch, { phase: "snoozed" }> }
  | { type: "no_pending" }
  | { type: "bad_code" };

export function applySnooze(
  watch: Watch | null,
  code: string | null,
  minutes: number,
  now: number,
): SnoozeResult {
  if (watch?.phase !== "reminded") return { type: "no_pending" };
  if (code !== watch.snoozeCode) return { type: "bad_code" };
  return {
    type: "ok",
    next: { phase: "snoozed", offSince: watch.offSince, snoozeUntil: now + minutes * MINUTE },
  };
}
