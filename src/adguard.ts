import type { Switch } from "./domain";
import type { Settings } from "./config";

const BASE = "https://api.adguard-dns.io/oapi";

type AdGuard = Settings["adguard"];

export async function readSwitches(adguard: AdGuard): Promise<Switch[]> {
  const [servers, devices] = await Promise.all([
    listAll(adguard, "/v2/dns_servers"),
    listAll(adguard, "/v2/devices"),
  ]);
  const server = servers.map(parseServer).find((s) => s.id === adguard.serverId);
  if (!server) throw new Error(`DNS server ${adguard.serverId || "(ADGUARD_SERVER_ID unset)"} not found`);
  return [
    server,
    ...devices.map(parseDevice).filter((d) => d.serverId === adguard.serverId).map(({ serverId, ...d }) => d),
  ];
}

export async function enableProtection(adguard: AdGuard, target: Switch): Promise<void> {
  const collection = target.kind === "server" ? "dns_servers" : "devices";
  const res = await fetch(`${BASE}/v1/${collection}/${encodeURIComponent(target.id)}/settings`, {
    method: "PUT",
    headers: { ...authHeader(adguard), "Content-Type": "application/json" },
    body: JSON.stringify({ protection_enabled: true }),
  });
  if (!res.ok) throw new Error(`PUT ${collection}/${target.id}/settings: HTTP ${res.status}`);
}

// v2 lists are cursor-paginated with a default page size of 10.
async function listAll(adguard: AdGuard, path: string): Promise<unknown[]> {
  const items: unknown[] = [];
  let cursor: string | null = null;
  do {
    const url = new URL(BASE + path);
    url.searchParams.set("limit", "1000");
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetch(url, { headers: authHeader(adguard) });
    if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
    const body = record(await res.json(), path);
    if (!Array.isArray(body.items)) throw new Error(`GET ${path}: no items array`);
    items.push(...body.items);
    cursor = nextCursor(body.navigation);
  } while (cursor);
  return items;
}

function nextCursor(navigation: unknown): string | null {
  if (typeof navigation !== "object" || navigation === null || !("next" in navigation)) return null;
  const next = navigation.next;
  if (typeof next !== "object" || next === null || !("page_cursor" in next)) return null;
  return typeof next.page_cursor === "string" && next.page_cursor ? next.page_cursor : null;
}

function parseServer(raw: unknown): Switch {
  const item = record(raw, "dns server");
  return {
    kind: "server",
    id: string(item.id, "dns server id"),
    name: string(item.name, "dns server name"),
    enabled: protectionEnabled(item.settings),
  };
}

function parseDevice(raw: unknown): Switch & { serverId: string } {
  const item = record(raw, "device");
  return {
    kind: "device",
    id: string(item.id, "device id"),
    name: string(item.name, "device name"),
    enabled: protectionEnabled(item.settings),
    serverId: string(item.dns_server_id, "device dns_server_id"),
  };
}

function protectionEnabled(settings: unknown): boolean {
  const value = record(settings, "settings").protection_enabled;
  if (typeof value !== "boolean") throw new Error("settings.protection_enabled is not a boolean");
  return value;
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) throw new Error(`${what} is not an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, what: string): string {
  if (typeof value !== "string") throw new Error(`${what} is not a string`);
  return value;
}

function authHeader(adguard: AdGuard) {
  return { Authorization: `ApiKey ${adguard.apiKey}` };
}
