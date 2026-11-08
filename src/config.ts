import type { Config } from "./domain";

export type Settings = {
  timing: Config;
  adguard: { apiKey: string; serverId: string };
  adminToken: string | null;
  publicUrl: string | null;
};

// Far beyond any real snooze, but keeps every computed time a valid Date.
const MAX_MINUTES = 1_000_000_000;

export function parseMinutes(raw: unknown): number | null {
  if (typeof raw !== "string" || !/^\d+$/.test(raw.trim())) return null;
  const minutes = Number(raw);
  return minutes >= 1 && minutes <= MAX_MINUTES ? minutes : null;
}

export function parseSettings(bindings: object): Settings {
  const env = bindings as Record<string, unknown>;
  const text = (name: string) => {
    const value = env[name];
    return typeof value === "string" ? value.trim() : "";
  };
  return {
    timing: {
      remindAfterMin: parseMinutes(env.REMIND_AFTER_MIN) ?? 60,
      autoEnableAfterMin: parseMinutes(env.AUTO_ENABLE_AFTER_MIN) ?? 5,
      defaultSnoozeMin: parseMinutes(env.DEFAULT_SNOOZE_MIN) ?? 60,
    },
    adguard: { apiKey: text("ADGUARD_DNS_API_KEY"), serverId: text("ADGUARD_SERVER_ID") },
    adminToken: text("ADGUARD_WATCH_WEBHOOKS_TOKEN") || null,
    publicUrl: URL.canParse(text("PUBLIC_URL")) ? text("PUBLIC_URL") : null,
  };
}
