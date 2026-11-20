import { addAllowedConnectionToApiKey, getApiKeyById } from "@/lib/db/apiKeys";
import {
  createProviderConnection,
  deleteProviderConnection,
  getProviderConnections,
  updateProviderConnection,
} from "@/lib/db/providers";
import { clearClaudeHeaderQuota } from "@/lib/quota/claudeHeaderQuota";

/**
 * Long-lived Claude token produced by `claude setup-token` (~1 year, no refresh
 * token, scope `user:inference` only). Pasted by the user, never exchanged.
 */
export const CLAUDE_SETUP_TOKEN_REGEX = /^sk-ant-oat01-[A-Za-z0-9_-]{20,512}$/;
export const CLAUDE_SETUP_TOKEN_AUTH_METHOD = "setup_token";
export const CLAUDE_SETUP_TOKEN_SCOPES = ["user:inference"];

type JsonRecord = Record<string, unknown>;

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

/** Trim and validate; returns the token or null. Never throws, never logs. */
export function parseClaudeSetupToken(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const token = raw.trim();
  return CLAUDE_SETUP_TOKEN_REGEX.test(token) ? token : null;
}

export interface UpsertClaudeSetupTokenInput {
  token: string;
  /** Display name, derived by the caller from the authenticated API key. */
  name: string;
  /** Id of the authenticated API key; stamped on the connection as `ownerKeyId`. */
  ownerKeyId: string;
  /** Connections already linked to the authenticated key (candidate scope). */
  ownerConnectionIds: string[];
}

/**
 * Create (or refresh) the setup-token Claude connection of ONE owner.
 *
 * Upsert rule (mirrors the sibling OAuth route, which also updates an existing
 * connection instead of piling up duplicates): if the key already links a claude
 * connection marked `authMethod: "setup_token"` AND stamped with
 * `providerSpecificData.ownerKeyId === ownerKeyId`, its token is replaced and any
 * terminal/error state is cleared; otherwise a new connection is created. The
 * `ownerKeyId` check stops a connection shared with another key (present in this
 * key's allowedConnections) from having its token swapped by a non-owner.
 * Candidates come ONLY from the key's own data, never from request input.
 *
 * Re-pasting the same (or a new) token is the supported way to reactivate a
 * connection parked as `expired`/`token_revoked`: the update clears every error
 * field (see test "re-posting revives ...").
 *
 * expiresAt is deliberately null: a far-future expiry would make a revoked token
 * look "still valid" to the 401 handling (see markAccountUnavailable).
 */
export async function upsertClaudeSetupTokenConnection(
  input: UpsertClaudeSetupTokenInput
): Promise<{ connection: { id: string; name: string }; created: boolean }> {
  const owned = new Set(input.ownerConnectionIds);
  const existing = (await getProviderConnections({ provider: "claude" })).find((c) => {
    const row = c as JsonRecord;
    const data = toRecord(row.providerSpecificData);
    return (
      owned.has(String(row.id)) &&
      data.authMethod === CLAUDE_SETUP_TOKEN_AUTH_METHOD &&
      data.ownerKeyId === input.ownerKeyId
    );
  }) as JsonRecord | undefined;

  const linkedAt = new Date().toISOString();

  if (existing) {
    // A re-link carries a new token: drop quota/probe state that belonged to the old one.
    const {
      lastRateLimit: _staleRateLimit,
      lastProbeAt: _staleProbeAt,
      lastProbeStatus: _staleProbeStatus,
      ...keptData
    } = toRecord(existing.providerSpecificData);
    clearClaudeHeaderQuota(String(existing.id));
    const updated = (await updateProviderConnection(String(existing.id), {
      accessToken: input.token,
      refreshToken: null,
      expiresAt: null,
      tokenExpiresAt: null,
      isActive: true,
      testStatus: "active",
      lastError: null,
      lastErrorType: null,
      lastErrorAt: null,
      errorCode: null,
      rateLimitedUntil: null,
      backoffLevel: 0,
      providerSpecificData: {
        ...keptData,
        authMethod: CLAUDE_SETUP_TOKEN_AUTH_METHOD,
        ownerKeyId: input.ownerKeyId,
        scopes: CLAUDE_SETUP_TOKEN_SCOPES,
        linkedAt,
      },
    })) as JsonRecord | null;
    return {
      connection: {
        id: String(existing.id),
        name: String(updated?.name ?? existing.name ?? input.name),
      },
      created: false,
    };
  }

  const created = (await createProviderConnection({
    provider: "claude",
    authType: "oauth",
    name: input.name,
    accessToken: input.token,
    refreshToken: null,
    expiresAt: null,
    isActive: true,
    testStatus: "active",
    providerSpecificData: {
      authMethod: CLAUDE_SETUP_TOKEN_AUTH_METHOD,
      ownerKeyId: input.ownerKeyId,
      scopes: CLAUDE_SETUP_TOKEN_SCOPES,
      linkedAt,
    },
  })) as JsonRecord;

  return {
    connection: { id: String(created.id), name: String(created.name ?? input.name) },
    created: true,
  };
}

export interface LinkClaudeSetupTokenInput extends UpsertClaudeSetupTokenInput {
  /** Injection points for tests; default to the real DB modules. */
  link?: (apiKeyId: string, connectionId: string) => Promise<{ status: string }>;
  removeConnection?: (connectionId: string) => Promise<unknown>;
}

/**
 * Upsert the connection AND link it to the key. There is no transaction that
 * spans the providers table and the api_keys table, so atomicity is by
 * compensation: when the link throws or reports `not_found` and the connection
 * was CREATED by this call, it is deleted again so a token-bearing active
 * connection is never left orphaned in the pool. A pre-existing (updated)
 * connection is kept.
 */
export async function linkClaudeSetupTokenConnection(input: LinkClaudeSetupTokenInput): Promise<{
  connection: { id: string; name: string };
  created: boolean;
  linkStatus: string;
}> {
  // Serialize per owner key: upsert is read-then-write, so two simultaneous
  // pastes with the same key would otherwise both create a connection.
  const previous = ownerLocks.get(input.ownerKeyId) ?? Promise.resolve();
  const run = previous.then(async () => {
    // Re-read the key's links inside the lock: a call that just finished may
    // have linked a connection the caller's (earlier) snapshot does not list.
    const fresh = await getApiKeyById(input.ownerKeyId).catch(() => null);
    const freshIds = Array.isArray(fresh?.allowedConnections) ? fresh.allowedConnections : [];
    return linkUnlocked({
      ...input,
      ownerConnectionIds: [...new Set([...input.ownerConnectionIds, ...freshIds])],
    });
  });
  const tail = run.then(
    () => undefined,
    () => undefined
  );
  ownerLocks.set(input.ownerKeyId, tail);
  try {
    return await run;
  } finally {
    if (ownerLocks.get(input.ownerKeyId) === tail) ownerLocks.delete(input.ownerKeyId);
  }
}

const ownerLocks = new Map<string, Promise<void>>();

async function linkUnlocked(input: LinkClaudeSetupTokenInput): Promise<{
  connection: { id: string; name: string };
  created: boolean;
  linkStatus: string;
}> {
  const { link = addAllowedConnectionToApiKey, removeConnection = deleteProviderConnection } =
    input;
  const { connection, created } = await upsertClaudeSetupTokenConnection(input);

  const compensate = async () => {
    if (!created) return;
    try {
      await removeConnection(connection.id);
    } catch {
      // Best effort: the original failure is what the caller must see.
    }
  };

  let linkStatus: string;
  try {
    linkStatus = (await link(input.ownerKeyId, connection.id)).status;
  } catch (error) {
    await compensate();
    throw error;
  }
  if (linkStatus === "not_found") await compensate();
  return { connection, created, linkStatus };
}
