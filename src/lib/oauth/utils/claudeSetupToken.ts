import {
  createProviderConnection,
  getProviderConnections,
  updateProviderConnection,
} from "@/lib/db/providers";

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
  /** Connections already linked to the authenticated key (the "owner" scope). */
  ownerConnectionIds: string[];
}

/**
 * Create (or refresh) the setup-token Claude connection of ONE owner.
 *
 * Upsert rule (mirrors the sibling OAuth route, which also updates an existing
 * connection instead of piling up duplicates): if the owner's key already links
 * a claude connection marked `authMethod: "setup_token"`, its token is replaced
 * and any terminal/error state is cleared; otherwise a new connection is created.
 * Candidates come ONLY from `ownerConnectionIds` (derived from the key), never
 * from request input.
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
    return (
      owned.has(String(row.id)) &&
      toRecord(row.providerSpecificData).authMethod === CLAUDE_SETUP_TOKEN_AUTH_METHOD
    );
  }) as JsonRecord | undefined;

  const linkedAt = new Date().toISOString();

  if (existing) {
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
        ...toRecord(existing.providerSpecificData),
        authMethod: CLAUDE_SETUP_TOKEN_AUTH_METHOD,
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
      scopes: CLAUDE_SETUP_TOKEN_SCOPES,
      linkedAt,
    },
  })) as JsonRecord;

  return {
    connection: { id: String(created.id), name: String(created.name ?? input.name) },
    created: true,
  };
}
