/**
 * Shared exchange-and-persist logic for the OAuth `exchange` action.
 *
 * Extracted verbatim (a behavior-preserving refactor) from the `exchange`
 * branch of `src/app/api/oauth/[provider]/[action]/route.ts`, so a
 * self-service "link your account" route can call the exact same
 * token-exchange + upsert + response-shaping logic without duplicating it.
 *
 * Deliberately does NOT perform the codeVerifier-required validation. That
 * check depends on provider capability flags (`flowType` /
 * `supportsBrowserPkce`, via `getProvider(provider)`) that are orthogonal to
 * the exchange-and-persist mechanics, and moving it in here would risk
 * changing the exact 400 response shape the route already produces. The
 * route keeps performing that check itself before calling this function.
 *
 * Throws on any failure (e.g. an upstream token-exchange error) — callers are
 * responsible for catching and mapping to their own error response, exactly
 * like the route's existing outer try/catch → generic sanitized 500.
 */
import { exchangeTokens } from "@/lib/oauth/providers";
import {
  findExistingOAuthConnectionMatch,
  buildOAuthConnectionCreatePayload,
} from "@/lib/oauth/connectionPersistence";
import {
  createProviderConnection,
  updateProviderConnection,
  getProviderConnections,
  isCloudEnabled,
  resolveProxyForProvider,
} from "@/models";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { syncToCloud } from "@/lib/cloudSync";
import { antigravityDegradedProjectState } from "@/lib/oauth/antigravityProjectGate";
import { runWithProxyContextOrDirect } from "@omniroute/open-sse/utils/proxyFetch.ts";

export interface ExchangeAndPersistConnectionInput {
  code: string;
  redirectUri: string;
  /** Optional hint to match/update a specific existing connection row. */
  connectionId?: string;
  codeVerifier?: string;
  state?: string;
}

export interface ExchangeAndPersistConnectionResult {
  connection: {
    id: string;
    provider: string;
    email: string;
    displayName: string;
  };
  /**
   * #11284: non-fatal warning when the connection was saved but marked
   * degraded (e.g. Antigravity Cloud Code projectId discovery failed).
   */
  warning?: string;
}

/**
 * Sync to Cloud if enabled. Kept as a private copy of the identically-named
 * helper at the bottom of route.ts (and the one in connectionPersistence.ts)
 * so this module has no import from the route itself.
 */
async function syncToCloudIfEnabled(): Promise<void> {
  try {
    const cloudEnabled = await isCloudEnabled();
    if (!cloudEnabled) return;

    const machineId = await getConsistentMachineId();
    await syncToCloud(machineId);
  } catch (error) {
    console.log("Error syncing to cloud after OAuth:", error);
  }
}

/**
 * Exchange an OAuth authorization code for tokens (through the provider's
 * configured proxy, if any) and persist the resulting connection: update the
 * existing provider+email match (Codex additionally requires
 * workspaceId/chatgptUserId agreement, #7737) or create a new one.
 */
export async function exchangeAndPersistConnection(
  provider: string,
  input: ExchangeAndPersistConnectionInput
): Promise<ExchangeAndPersistConnectionResult> {
  const { code, redirectUri, connectionId, codeVerifier, state } = input;
  const normalizedState = typeof state === "string" && state.length > 0 ? state : undefined;

  // Resolve proxy for this provider (provider-level → global → direct)
  const proxy = await resolveProxyForProvider(provider);

  // Exchange code for tokens (through proxy if configured)
  const tokenData = await runWithProxyContextOrDirect(proxy, () =>
    exchangeTokens(provider, code, redirectUri, codeVerifier, normalizedState)
  );

  // #11284: when Cloud Code projectId discovery failed at connect time, SAVE
  // the connection but mark it degraded (maintainer direction on #11284) —
  // the refresh token stays stored and request-time bootstrap self-heals the
  // row once Google assigns a project.
  const degradedProject = antigravityDegradedProjectState(provider, tokenData);

  // Normalize: if name is missing, use email or displayName as fallback so accounts
  // always show a real label (e.g. user@gmail.com) instead of "Account #abc123"
  if (!tokenData.name && (tokenData.email || tokenData.displayName)) {
    tokenData.name = tokenData.email || tokenData.displayName;
  }

  // Upsert: update existing connection if same provider+email, else create new
  const expiresAt = tokenData.expiresIn
    ? new Date(Date.now() + tokenData.expiresIn * 1000).toISOString()
    : null;

  let connection: any;
  if (tokenData.email) {
    const existing = await getProviderConnections({ provider });
    // Codex accounts sharing an email require workspaceId/chatgptUserId
    // agreement to be treated as the same account (#7737).
    const match = findExistingOAuthConnectionMatch(existing, provider, tokenData, connectionId);
    const matchId = typeof match?.id === "string" ? match.id : null;
    if (matchId) {
      connection = await updateProviderConnection(matchId, {
        ...tokenData,
        expiresAt,
        testStatus: degradedProject?.testStatus ?? "active",
        ...(degradedProject ?? {}),
        isActive: true,
      });
    }
  }
  if (!connection) {
    connection = await createProviderConnection(
      buildOAuthConnectionCreatePayload(provider, tokenData, expiresAt, degradedProject)
    );
  }

  // Auto sync to Cloud if enabled
  await syncToCloudIfEnabled();

  return {
    connection: {
      id: connection.id,
      provider: connection.provider,
      email: connection.email,
      displayName: connection.displayName,
    },
    ...(degradedProject ? { warning: degradedProject.warning } : {}),
  };
}
