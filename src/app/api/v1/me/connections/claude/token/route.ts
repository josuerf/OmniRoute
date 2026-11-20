import { NextResponse } from "next/server";

import { addAllowedConnectionToApiKey } from "@/lib/db/apiKeys";
import { getAuditRequestContext, logAuditEvent } from "@/lib/compliance";
import { hasSelfUsageScope } from "@/shared/constants/selfServiceScopes";
import {
  CLAUDE_SETUP_TOKEN_AUTH_METHOD,
  parseClaudeSetupToken,
  upsertClaudeSetupTokenConnection,
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

  let rawBody: unknown;
  try {
    rawBody = await request.json();
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
    const { connection, created } = await upsertClaudeSetupTokenConnection({
      token,
      name: `Claude (setup-token) - ${keyLabel}`,
      ownerConnectionIds: Array.isArray(metadata.allowedConnections)
        ? metadata.allowedConnections
        : [],
    });

    // Link ONLY the connection id produced/updated above for the caller's key.
    const linkResult = await addAllowedConnectionToApiKey(metadata.id, connection.id);
    if (linkResult.status === "not_found") return authError(401);

    if (linkResult.status === "linked") {
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
