import { NextResponse } from "next/server";

import { getAuditRequestContext, logAuditEvent } from "@/lib/compliance";
import { hasSelfUsageScope } from "@/shared/constants/selfServiceScopes";
import {
  CLAUDE_SETUP_TOKEN_AUTH_METHOD,
  parseClaudeSetupToken,
  linkClaudeSetupTokenConnection,
} from "@/lib/oauth/utils/claudeSetupToken";

function extractBearerToken(request: Request): string | null {
  const authorization = request.headers.get("Authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  return token ? token : null;
}

function authError(status = 401) {
  return NextResponse.json({ error: status === 401 ? "Unauthorized" : "Forbidden" }, { status });
}

/** The body is `{ token }` (~120 chars); anything above this is abuse. */
const MAX_BODY_BYTES = 8 * 1024;

function payloadTooLarge() {
  return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
}

function invalidTokenFormat() {
  return NextResponse.json({ error: "invalid_token_format" }, { status: 400 });
}

/**
 * POST /api/v1/me/connections/claude/token — self-service link of a pasted
 * long-lived Claude token (`claude setup-token`, `sk-ant-oat01-...`).
 * Sibling of `POST /api/v1/me/connections/claude` (OAuth exchange+link): same
 * Bearer API-key auth and `self:usage` scope.
 *
 * SECURITY: the connection owner (the calling key) and its display name are
 * derived ONLY from the authenticated key. The body is `{ token }` and nothing
 * else is read from it — never a `connectionId`, owner or name (structural
 * IDOR, see the sibling route). The token is never logged, audited or echoed.
 * Bodies above 8 KB are refused with 413 `payload_too_large`.
 *
 * Revocation (by design): a 401 from upstream on a claude connection WITHOUT a
 * refresh token is terminal (`expired`/`token_revoked`, see
 * `src/sse/services/auth.ts`); nothing retries it. Pasting the same token again
 * (or a new one) reactivates it: the upsert clears every error field.
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

  const declaredLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) return payloadTooLarge();

  let rawBody: unknown;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return payloadTooLarge();
    rawBody = JSON.parse(text);
  } catch {
    return invalidTokenFormat();
  }
  const token = parseClaudeSetupToken((rawBody as { token?: unknown } | null)?.token);
  if (!token) return invalidTokenFormat();

  try {
    const keyLabel =
      typeof metadata.name === "string" && metadata.name.trim()
        ? metadata.name.trim()
        : metadata.id;
    // Creates/updates the connection and links it to the caller's key; if the
    // link fails the created connection is removed (no orphan with a live token).
    const { connection, created, linkStatus } = await linkClaudeSetupTokenConnection({
      token,
      name: `Claude (setup-token) - ${keyLabel}`,
      ownerKeyId: metadata.id,
      ownerConnectionIds: Array.isArray(metadata.allowedConnections)
        ? metadata.allowedConnections
        : [],
    });

    if (linkStatus === "not_found") return authError(401);

    if (linkStatus === "linked") {
      const auditContext = getAuditRequestContext(request);
      logAuditEvent({
        action: "apiKey.connections.link",
        actor: metadata.id,
        target: metadata.id,
        resourceType: "api_key",
        status: "success",
        details: {
          connectionId: connection.id,
          provider: "claude",
          authMethod: CLAUDE_SETUP_TOKEN_AUTH_METHOD,
        },
        ipAddress: auditContext.ipAddress || undefined,
        requestId: auditContext.requestId,
      });
    }

    return NextResponse.json(
      {
        status: created ? "created" : "updated",
        connectionId: connection.id,
        name: connection.name,
        provider: "claude",
        authMethod: CLAUDE_SETUP_TOKEN_AUTH_METHOD,
      },
      { status: created ? 201 : 200 }
    );
  } catch (error) {
    // Generic message only: never log the body, Bearer key or token.
    console.error(
      "POST /api/v1/me/connections/claude/token error:",
      error instanceof Error ? error.name : "unknown"
    );
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
