/**
 * Claude quota read from `anthropic-ratelimit-unified-*` response headers.
 *
 * Setup-token connections (scopes without `user:profile`) cannot call the OAuth
 * usage endpoint, but every /v1/messages response carries the 5h/7d window state.
 * ASSUMPTIONS, to be confirmed with a real token (IAF-2820): utilization is a
 * fraction 0..1 (x100 -> percent, clamped, never reinterpreted as a percent);
 * reset is epoch seconds (ms and ISO tolerated); status is allowed |
 * allowed_warning | rejected. Only the header names below are ever read.
 */
import { CLAUDE_UNIFIED_HEADERS } from "../../../open-sse/services/claudeLowPriority.ts";
import { normalizeClaudeUsageQuotas } from "../../../open-sse/services/usage/claudeQuota.ts";

export type ClaudeHeaderWindow = {
  /** Percent used, 0..100. */
  utilization: number;
  resetAt: string | null;
  status: string | null;
};
export type ClaudeHeaderReading = {
  fiveHour?: ClaudeHeaderWindow;
  sevenDay?: ClaudeHeaderWindow;
  status?: string;
  /** Epoch ms. */
  observedAt: number;
};
type HeaderSource = Headers | Record<string, unknown>;
type JsonRecord = Record<string, unknown>;

export const CLAUDE_HEADER_QUOTA_STALE_MS = 60 * 60 * 1000;
export const CLAUDE_HEADER_QUOTA_PERSIST_MIN_INTERVAL_MS = 60 * 1000;
export const CLAUDE_HEADER_QUOTA_PSD_KEY = "lastRateLimit";
const MAX_ENTRIES = 2000;

function getHeader(h: HeaderSource, name: string): string | null {
  try {
    if (typeof (h as Headers).get === "function") return (h as Headers).get(name);
    const lower = name.toLowerCase();
    for (const [k, v] of Object.entries(h as JsonRecord)) {
      if (k.toLowerCase() === lower && v != null) return String(v);
    }
  } catch {
    /* never throw */
  }
  return null;
}

function parseUtilizationPercent(raw: string | null): number | null {
  if (raw == null || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.min(100, Math.max(0, n * 100)); // fraction premise
}

function parseResetIso(raw: string | null): string | null {
  if (raw == null || raw.trim() === "") return null;
  let ms: number;
  if (/^\d+(\.\d+)?$/.test(raw.trim())) {
    const n = Number(raw);
    ms = n < 1e12 ? n * 1000 : n;
  } else {
    ms = Date.parse(raw);
  }
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function parseWindow(h: HeaderSource, util: string, reset: string, status: string) {
  const utilization = parseUtilizationPercent(getHeader(h, util));
  if (utilization === null) return undefined;
  return {
    utilization,
    resetAt: parseResetIso(getHeader(h, reset)),
    status: getHeader(h, status)?.trim().toLowerCase() || null,
  } satisfies ClaudeHeaderWindow;
}

/** Null when there is no 5h/7d window header. */
export function parseClaudeUnifiedHeaders(
  headers: HeaderSource | null | undefined,
  now: number = Date.now()
): ClaudeHeaderReading | null {
  if (!headers) return null;
  const h = CLAUDE_UNIFIED_HEADERS;
  const fiveHour = parseWindow(headers, h.utilization5h, h.reset5h, h.status5h);
  const sevenDay = parseWindow(headers, h.utilization7d, h.reset7d, h.status7d);
  if (!fiveHour && !sevenDay) return null;
  const status = getHeader(headers, h.status)?.trim().toLowerCase();
  return {
    ...(fiveHour && { fiveHour }),
    ...(sevenDay && { sevenDay }),
    ...(status && { status }),
    observedAt: now,
  };
}

/** Same rule as open-sse/services/usage.ts: scopes array without `user:profile`. */
export function isClaudeHeaderQuotaConnection(psd: unknown): boolean {
  if (!psd || typeof psd !== "object") return false;
  const scopes = (psd as JsonRecord).scopes;
  return Array.isArray(scopes) && !scopes.includes("user:profile");
}

/** A window whose reset already passed no longer describes the current window. */
function windowIsLive(w: ClaudeHeaderWindow | undefined, now: number): w is ClaudeHeaderWindow {
  if (!w) return false;
  if (w.resetAt) {
    const t = Date.parse(w.resetAt);
    if (Number.isFinite(t) && t <= now) return false;
  }
  return true;
}

export function isClaudeHeaderReadingFresh(
  r: ClaudeHeaderReading | null | undefined,
  now: number = Date.now()
): r is ClaudeHeaderReading {
  return !!r && now - r.observedAt <= CLAUDE_HEADER_QUOTA_STALE_MS && now >= r.observedAt - 60_000;
}

/** Same keys as the OAuth path: "session (5h)" and "weekly (7d)". Stale windows are dropped. */
export function toQuotaWindows(
  reading: ClaudeHeaderReading | null | undefined,
  now: number = Date.now()
): { quotas: JsonRecord } {
  if (!isClaudeHeaderReadingFresh(reading, now)) return { quotas: {} };
  const payload: JsonRecord = {};
  if (windowIsLive(reading.fiveHour, now)) {
    payload.five_hour = {
      utilization: reading.fiveHour.utilization,
      resets_at: reading.fiveHour.resetAt,
    };
  }
  if (windowIsLive(reading.sevenDay, now)) {
    payload.seven_day = {
      utilization: reading.sevenDay.utilization,
      resets_at: reading.sevenDay.resetAt,
    };
  }
  if (Object.keys(payload).length === 0) return { quotas: {} };
  return { quotas: normalizeClaudeUsageQuotas(payload).quotas as unknown as JsonRecord };
}

const memory = new Map<string, ClaudeHeaderReading>();
const lastPersist = new Map<string, { at: number; sig: string }>();

function bound<V>(m: Map<string, V>) {
  while (m.size > MAX_ENTRIES) {
    const first = m.keys().next().value;
    if (first === undefined) break;
    m.delete(first);
  }
}

function signature(r: ClaudeHeaderReading): string {
  const w = (x?: ClaudeHeaderWindow) =>
    x ? `${Math.round(x.utilization * 10)}|${x.resetAt}|${x.status}` : "-";
  return `${w(r.fiveHour)}#${w(r.sevenDay)}#${r.status ?? ""}`;
}

function toStored(r: ClaudeHeaderReading): JsonRecord {
  return { ...r, observedAt: new Date(r.observedAt).toISOString() };
}

/** Parse a persisted `providerSpecificData.lastRateLimit`. */
export function readStoredClaudeHeaderQuota(psd: unknown): ClaudeHeaderReading | null {
  const raw = psd && typeof psd === "object" ? (psd as JsonRecord)[CLAUDE_HEADER_QUOTA_PSD_KEY] : null;
  if (!raw || typeof raw !== "object") return null;
  const o = raw as JsonRecord;
  const observedAt = typeof o.observedAt === "string" ? Date.parse(o.observedAt) : Number(o.observedAt);
  if (!Number.isFinite(observedAt)) return null;
  const win = (v: unknown): ClaudeHeaderWindow | undefined => {
    if (!v || typeof v !== "object") return undefined;
    const w = v as JsonRecord;
    const utilization = Number(w.utilization);
    if (!Number.isFinite(utilization)) return undefined;
    return {
      utilization: Math.min(100, Math.max(0, utilization)),
      resetAt: typeof w.resetAt === "string" ? w.resetAt : null,
      status: typeof w.status === "string" ? w.status : null,
    };
  };
  const fiveHour = win(o.fiveHour);
  const sevenDay = win(o.sevenDay);
  if (!fiveHour && !sevenDay) return null;
  return {
    ...(fiveHour && { fiveHour }),
    ...(sevenDay && { sevenDay }),
    ...(typeof o.status === "string" && { status: o.status }),
    observedAt,
  };
}

export type ClaudeHeaderQuotaDeps = {
  /** Persists into providerSpecificData.lastRateLimit. Never touches tokens. */
  persist?: (connectionId: string, stored: JsonRecord) => Promise<void>;
  /** Feeds the routing quota cache. */
  feedCache?: (connectionId: string, quotas: JsonRecord) => void;
};

async function defaultPersist(connectionId: string, stored: JsonRecord) {
  const { getProviderConnectionById, updateProviderConnection } = await import(
    "../db/providers.ts"
  );
  const conn = (await getProviderConnectionById(connectionId)) as JsonRecord | null;
  const psd = conn?.providerSpecificData;
  if (!psd || typeof psd !== "object" || !isClaudeHeaderQuotaConnection(psd)) return;
  // Only providerSpecificData is sent; accessToken/refreshToken are not in the patch.
  await updateProviderConnection(connectionId, {
    providerSpecificData: { ...(psd as JsonRecord), [CLAUDE_HEADER_QUOTA_PSD_KEY]: stored },
  });
}

function defaultFeedCache(connectionId: string, quotas: JsonRecord) {
  void import("@/domain/quotaCache")
    .then((m) => m.setQuotaCache(connectionId, "claude", quotas))
    .catch(() => {});
}

/**
 * Record the quota carried by a claude response. No-op (returns null) for OAuth
 * connections, missing connection id or headers without window data. Never throws.
 * `ctx.providerSpecificData` is the connection's psd (used for the scopes rule).
 */
export function recordClaudeHeaderQuota(
  connectionId: string | null | undefined,
  headers: HeaderSource | null | undefined,
  now: number = Date.now(),
  ctx: { providerSpecificData?: unknown } & ClaudeHeaderQuotaDeps = {}
): ClaudeHeaderReading | null {
  try {
    if (!connectionId || !isClaudeHeaderQuotaConnection(ctx.providerSpecificData)) return null;
    const reading = parseClaudeUnifiedHeaders(headers, now);
    if (!reading) return null;
    memory.delete(connectionId);
    memory.set(connectionId, reading);
    bound(memory);

    const quotas = toQuotaWindows(reading, now).quotas;
    if (Object.keys(quotas).length > 0) {
      (ctx.feedCache ?? defaultFeedCache)(connectionId, quotas);
    }

    const sig = signature(reading);
    const prev = lastPersist.get(connectionId);
    if (
      !prev ||
      (prev.sig !== sig && now - prev.at >= CLAUDE_HEADER_QUOTA_PERSIST_MIN_INTERVAL_MS)
    ) {
      lastPersist.delete(connectionId);
      lastPersist.set(connectionId, { at: now, sig });
      bound(lastPersist);
      Promise.resolve((ctx.persist ?? defaultPersist)(connectionId, toStored(reading))).catch(
        () => {}
      );
    }
    return reading;
  } catch {
    return null;
  }
}

/** Memory first, then the persisted `lastRateLimit` of `psd` when given. */
export function getClaudeHeaderQuota(
  connectionId: string,
  psd?: unknown
): ClaudeHeaderReading | null {
  return memory.get(connectionId) ?? readStoredClaudeHeaderQuota(psd);
}

export function clearClaudeHeaderQuota(connectionId?: string): void {
  if (connectionId === undefined) {
    memory.clear();
    lastPersist.clear();
    return;
  }
  memory.delete(connectionId);
  lastPersist.delete(connectionId);
}
