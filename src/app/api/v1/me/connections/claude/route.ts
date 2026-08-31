import { NextResponse } from "next/server";

import { exchangeAndPersistConnection } from "@/lib/oauth/exchangeAndPersistConnection";
import { addAllowedConnectionToApiKey } from "@/lib/db/apiKeys";
import { getAuditRequestContext, logAuditEvent } from "@/lib/compliance";
import { hasSelfUsageScope } from "@/shared/constants/selfServiceScopes";
import { v1MeConnectionClaudeExchangeSchema } from "@/shared/validation/schemas";
import { validatedJsonBody } from "@/shared/validation/helpers";

function extractBearerToken(request: Request): string | null {
  const authorization = request.headers.get("Authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  return token ? token : null;
}

function authError(status = 401) {
  return NextResponse.json({ error: status === 401 ? "Unauthorized" : "Forbidden" }, { status });
}

/**
 * POST /api/v1/me/connections/claude — self-service combined OAuth
 * exchange+link. Consumed by an external self-service account-linking
 * portal (a separate deployment, not part of this repository).
 *
 * SECURITY: neither `api_keys` nor `provider_connections` carries an
 * owner/account column in this schema. A route that accepted a bare,
 * caller-supplied `connectionId` and linked it to the caller's key would
 * therefore be a structural IDOR —
 * any valid API key could link ANY existing Claude connection in the
 * database by guessing/observing its UUID. This route avoids that
 * entirely: it performs the OAuth exchange itself (via
 * `exchangeAndPersistConnection`) and links ONLY the connection id that
 * exchange call just produced, in this same authenticated request. There is
 * no code path here that reads a `connectionId` from the request body — do
 * not add one, even as an optional field.
 */
export async function POST(request: Request) {
  const apiKey = extractBearerToken(request);
  if (!apiKey) return authError(401);

  const { validateApiKey, getApiKeyMetadata } = await import("@/lib/db/apiKeys");

  const valid = await validateApiKey(apiKey);
  if (!valid) return authError(401);

  const metadata = await getApiKeyMetadata(apiKey);
  if (!metadata || metadata.id === "env-key") return authError(401);

  if (!hasSelfUsageScope(metadata.scopes)) return authError(403);

  const parsedBody = await validatedJsonBody(request, v1MeConnectionClaudeExchangeSchema);
  if (!parsedBody.success) return parsedBody.response;

  const { code, redirectUri, codeVerifier, state } = parsedBody.data;

  try {
    // Exchange the authorization code for tokens and persist the resulting
    // provider connection — shared logic with the existing
    // /api/oauth/claude/exchange action.
    const { connection } = await exchangeAndPersistConnection("claude", {
      code,
      redirectUri,
      codeVerifier,
      state,
    });

    // Link the connection this exchange call JUST produced onto the
    // caller's own key. `metadata.id` comes from the Bearer key that was
    // just validated above — never from request input.
    const linkResult = await addAllowedConnectionToApiKey(metadata.id, connection.id);

    if (linkResult.status === "not_found") {
      // The Bearer key validated moments ago but no longer exists (e.g. a
      // concurrent deletion) — treat like any other now-invalid credential
      // rather than leaking internal state.
      return authError(401);
    }

    if (linkResult.status === "linked") {
      // Only audit the actual mutation (a new connection was added), not
      // the idempotent "already_linked" no-op. `allowedConnections` is now
      // mutable by any developer key via this self-service route, so record
      // who linked what — ids only, never the raw API key value or tokens.
      const auditContext = getAuditRequestContext(request);
      logAuditEvent({
        action: "apiKey.connections.link",
        actor: metadata.id,
        target: metadata.id,
        resourceType: "api_key",
        status: "success",
        details: { connectionId: linkResult.connectionId, provider: "claude" },
        ipAddress: auditContext.ipAddress || undefined,
        requestId: auditContext.requestId,
      });
    }

    return NextResponse.json({
      status: linkResult.status,
      connectionId: linkResult.connectionId,
      provider: "claude",
    });
  } catch (error) {
    // Sanitized generic error: same shape as the outer catch in
    // /api/oauth/[provider]/[action]'s POST handler, so no upstream error
    // body or token material is ever exposed to the caller. Never log the
    // request body, the Bearer key, or the exchanged tokens here.
    console.error("POST /api/v1/me/connections/claude error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
