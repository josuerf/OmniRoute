import { DefaultExecutor } from "@omniroute/open-sse/executors/default.ts";
import { getRegistryEntry } from "@omniroute/open-sse/config/providerRegistry.ts";
import { recordClaudeHeaderQuota } from "@/lib/quota/claudeHeaderQuota";
import { CLAUDE_SETUP_TOKEN_AUTH_METHOD } from "@/lib/oauth/utils/claudeSetupToken";

/**
 * Active health probe for `claude setup-token` connections (D2): one minimal
 * `/v1/messages` call (max_tokens 1) per connection per interval. It detects a revoked
 * token early (401 -> `token_revoked`, same path as a live request) and refreshes the
 * header-based quota reading. It never logs or returns the token or request headers.
 */

type JsonRecord = Record<string, unknown>;

export const CLAUDE_SETUP_TOKEN_PROBE_INTERVAL_ENV = "CLAUDE_SETUP_TOKEN_PROBE_INTERVAL_HOURS";
export const CLAUDE_SETUP_TOKEN_PROBE_DEFAULT_HOURS = 24;
export const CLAUDE_SETUP_TOKEN_PROBE_TIMEOUT_MS = 10_000;
const FALLBACK_PROBE_MODEL = "claude-haiku-4-5-20251001";
const OFF_VALUES = new Set(["0", "false", "off", "no", "disabled", "none"]);
const LOG_PREFIX = "[claude-setup-token-probe]";

export type ClaudeProbeOutcome = "ok" | "revoked" | "transient";

export interface ClaudeProbeConnection {
  id: string;
  accessToken?: string | null;
  providerSpecificData?: unknown;
  [key: string]: unknown;
}

export interface ClaudeProbeDeps {
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  /** Marks the connection revoked through the live-request path (markAccountUnavailable). */
  markRevoked?: (connectionId: string, model: string) => Promise<unknown>;
  getConnection?: (id: string) => Promise<JsonRecord | null>;
  updateConnection?: (id: string, patch: JsonRecord) => Promise<unknown>;
  recordQuota?: typeof recordClaudeHeaderQuota;
  log?: (message: string) => void;
}

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

/** Interval in ms, or null when the probe is disabled (`0`/`false`/`off`). */
export function getClaudeSetupTokenProbeIntervalMs(
  env: Record<string, string | undefined> = process.env
): number | null {
  const raw = env[CLAUDE_SETUP_TOKEN_PROBE_INTERVAL_ENV]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return CLAUDE_SETUP_TOKEN_PROBE_DEFAULT_HOURS * 3_600_000;
  if (OFF_VALUES.has(raw)) return null;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours < 0)
    return CLAUDE_SETUP_TOKEN_PROBE_DEFAULT_HOURS * 3_600_000;
  if (hours === 0) return null;
  return hours * 3_600_000;
}

/** Smallest Claude model of the registry (haiku), so one probe costs next to nothing. */
export function getClaudeProbeModel(): string {
  const models = (getRegistryEntry("claude")?.models ?? []) as Array<{ id?: string }>;
  return (
    models.find((m) => typeof m.id === "string" && m.id.includes("haiku"))?.id ??
    FALLBACK_PROBE_MODEL
  );
}

/** Active, setup-token, not revoked, with a token, and last probe older than the interval. */
export function isClaudeSetupTokenProbeDue(
  conn: ClaudeProbeConnection,
  now: number,
  intervalMs: number
): boolean {
  const row = conn as JsonRecord;
  if (row.provider !== undefined && row.provider !== "claude") return false;
  if (row.isActive === false) return false;
  if (row.lastErrorType === "token_revoked" || row.testStatus === "expired") return false;
  const psd = toRecord(conn.providerSpecificData);
  if (psd.authMethod !== CLAUDE_SETUP_TOKEN_AUTH_METHOD) return false;
  if (typeof conn.accessToken !== "string" || !conn.accessToken) return false;
  const last = typeof psd.lastProbeAt === "string" ? Date.parse(psd.lastProbeAt) : NaN;
  return !Number.isFinite(last) || now - last >= intervalMs;
}

async function defaultMarkRevoked(connectionId: string, model: string) {
  const { markAccountUnavailable } = await import("@/sse/services/auth");
  return markAccountUnavailable(
    connectionId,
    401,
    "Claude setup token probe rejected (401)",
    "claude",
    model
  );
}

async function defaultGetConnection(id: string) {
  const { getProviderConnectionById } = await import("@/lib/db/providers");
  return (await getProviderConnectionById(id)) as JsonRecord | null;
}

async function defaultUpdateConnection(id: string, patch: JsonRecord) {
  const { updateProviderConnection } = await import("@/lib/db/providers");
  return updateProviderConnection(id, patch);
}

/**
 * Probe one connection. Never throws and never revokes on anything but a 401:
 * 429/5xx/network/timeout/other statuses are logged (status only) and retried next cycle.
 */
export async function probeClaudeSetupTokenConnection(
  conn: ClaudeProbeConnection,
  deps: ClaudeProbeDeps = {}
): Promise<ClaudeProbeOutcome> {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((m: string) => console.log(m));
  const getConnection = deps.getConnection ?? defaultGetConnection;
  const updateConnection = deps.updateConnection ?? defaultUpdateConnection;
  const markRevoked = deps.markRevoked ?? defaultMarkRevoked;
  const recordQuota = deps.recordQuota ?? recordClaudeHeaderQuota;
  const model = getClaudeProbeModel();
  const psd = toRecord(conn.providerSpecificData);

  // Same URL and headers the live executor uses for this connection.
  const executor = new DefaultExecutor("claude");
  const credentials = {
    connectionId: conn.id,
    accessToken: conn.accessToken ?? undefined,
    providerSpecificData: psd,
  };

  let status: number;
  let headers: Headers;
  try {
    const url = executor.buildUrl(model, false, 0, credentials as never);
    const res = await doFetch(url, {
      method: "POST",
      headers: executor.buildHeaders(credentials as never, false, null, model),
      body: JSON.stringify({
        model,
        max_tokens: 1,
        messages: [{ role: "user", content: "." }],
      }),
      signal: AbortSignal.timeout(deps.timeoutMs ?? CLAUDE_SETUP_TOKEN_PROBE_TIMEOUT_MS),
    });
    status = res.status;
    headers = res.headers;
    await res.body?.cancel().catch(() => {});
  } catch (err) {
    const kind = err instanceof Error ? err.name : "error";
    log(`${LOG_PREFIX} connection ${conn.id}: request failed (${kind}); will retry next cycle`);
    return "transient";
  }

  const at = new Date(now()).toISOString();
  const stamp = async (extra: JsonRecord = {}, patch: JsonRecord = {}) => {
    const fresh = await getConnection(conn.id).catch(() => null);
    if (!fresh) return;
    await updateConnection(conn.id, {
      ...patch,
      providerSpecificData: {
        ...toRecord(fresh.providerSpecificData),
        lastProbeAt: at,
        lastProbeStatus: status,
        ...extra,
      },
    }).catch(() => {});
  };

  if (status === 401) {
    try {
      await markRevoked(conn.id, model);
    } catch {
      log(`${LOG_PREFIX} connection ${conn.id}: failed to mark token_revoked`);
      return "transient";
    }
    await stamp();
    log(`${LOG_PREFIX} connection ${conn.id}: token rejected (401), marked token_revoked`);
    return "revoked";
  }

  if (status >= 200 && status < 300) {
    const hadError = typeof conn.lastErrorType === "string" && conn.lastErrorType !== "";
    await stamp(
      {},
      hadError
        ? {
            testStatus: "active",
            lastError: null,
            lastErrorType: null,
            lastErrorAt: null,
            errorCode: null,
          }
        : {}
    );
    recordQuota(conn.id, headers, now(), {
      providerSpecificData: toRecord(conn.providerSpecificData),
    });
    return "ok";
  }

  log(`${LOG_PREFIX} connection ${conn.id}: upstream status ${status}; will retry next cycle`);
  return "transient";
}

export interface ClaudeProbeSweepDeps extends ClaudeProbeDeps {
  listConnections?: () => Promise<ClaudeProbeConnection[]>;
  env?: Record<string, string | undefined>;
}

/** Serial sweep over the due connections. Returns how many were probed. */
export async function probeDueClaudeSetupTokenConnections(
  deps: ClaudeProbeSweepDeps = {}
): Promise<{ probed: number; disabled: boolean }> {
  const intervalMs = getClaudeSetupTokenProbeIntervalMs(deps.env);
  if (intervalMs === null) return { probed: 0, disabled: true };
  const now = deps.now ?? Date.now;
  const list =
    deps.listConnections ??
    (async () => {
      const { getProviderConnections } = await import("@/lib/db/providers");
      return (await getProviderConnections({ provider: "claude" })) as ClaudeProbeConnection[];
    });
  const due = (await list()).filter((c) => isClaudeSetupTokenProbeDue(c, now(), intervalMs));
  let probed = 0;
  for (const conn of due) {
    await probeClaudeSetupTokenConnection(conn, deps);
    probed += 1;
  }
  return { probed, disabled: false };
}
