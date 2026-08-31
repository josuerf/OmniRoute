/**
 * Tests for the self-service combined exchange+link route
 * `POST /api/v1/me/connections/claude`.
 *
 * This route:
 *   1. authenticates the caller's own Bearer API key exactly like
 *      `src/app/api/v1/me/status/route.ts` (`validateApiKey` +
 *      `getApiKeyMetadata` + `hasSelfUsageScope`);
 *   2. performs the OAuth exchange itself via
 *      `exchangeAndPersistConnection("claude", ...)`;
 *   3. links ONLY the connection id that exchange call just produced onto
 *      the caller's own key via `addAllowedConnectionToApiKey` (the merge
 *      helper) — never a caller-supplied `connectionId`.
 *
 * DB handles released in test.after (CLAUDE.md learning: unreleased SQLite
 * handles hang node:test).
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const routeSourcePath = path.join(repoRoot, "src/app/api/v1/me/connections/claude/route.ts");

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-v1-me-connections-claude-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "connections-claude-route-test-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../../src/lib/db/core.ts");
const settingsDb = await import("../../../src/lib/db/settings.ts");
const apiKeysDb = await import("../../../src/lib/db/apiKeys.ts");
const { buildApiKeyConnectionsFixture } = await import("../../helpers/apiKeyConnectionsFixture.ts");
const route = await import("../../../src/app/api/v1/me/connections/claude/route.ts");

const originalFetch = globalThis.fetch;

test.before(async () => {
  await settingsDb.updateSettings({ requireLogin: false });
});

test.after(() => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

function postRoute(body: unknown, bearer?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (bearer !== undefined) headers.Authorization = bearer;
  const init: RequestInit = { method: "POST", headers };
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return route.POST(new Request("http://localhost/api/v1/me/connections/claude", init));
}

/** Mocks both the token-exchange POST and the best-effort bootstrap GET with
 * a single response shape (no `oauth_account`, so bootstrap is a no-op and
 * the created connection has no email — matching how the existing
 * claude-oauth-provider.test.ts exercises the token-only success path). */
function mockSuccessfulClaudeExchange() {
  globalThis.fetch = (async () =>
    Response.json({
      access_token: "test-access-token",
      refresh_token: "test-refresh-token",
      expires_in: 3600,
    })) as typeof fetch;
}

const validExchangeBody = {
  code: "auth-code",
  redirectUri: "http://127.0.0.1:56121/callback",
  codeVerifier: "verifier-123",
  state: "state-abc",
};

test("POST /api/v1/me/connections/claude rejects a missing Authorization header (401)", async () => {
  const res = await postRoute(validExchangeBody);
  assert.equal(res.status, 401);
});

test("POST /api/v1/me/connections/claude rejects an invalid Bearer token (401)", async () => {
  const res = await postRoute(validExchangeBody, "Bearer not-a-real-key");
  assert.equal(res.status, 401);
});

test("POST /api/v1/me/connections/claude rejects a key lacking self:usage scope (403)", async () => {
  const managementOnlyKey = await apiKeysDb.createApiKey(
    "connections-claude-no-self-usage",
    "machine-no-self-usage",
    ["manage"]
  );

  const res = await postRoute(validExchangeBody, `Bearer ${managementOnlyKey.key}`);
  assert.equal(res.status, 403);
});

test("POST /api/v1/me/connections/claude rejects an invalid JSON body (400)", async () => {
  const fixture = await buildApiKeyConnectionsFixture();

  const res = await postRoute("{not valid json", `Bearer ${fixture.zeroConnections.apiKey.key}`);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.message, "Invalid request");
  assert.equal(body.error.details[0].field, "body");
});

test("POST /api/v1/me/connections/claude rejects a body missing codeVerifier (400)", async () => {
  const fixture = await buildApiKeyConnectionsFixture();

  const res = await postRoute(
    { code: "auth-code", redirectUri: "http://127.0.0.1:56121/callback" },
    `Bearer ${fixture.zeroConnections.apiKey.key}`
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.message, "Invalid request");
  assert.ok(
    body.error.details.some((d: { field: string }) => d.field === "codeVerifier"),
    "expected a codeVerifier field error"
  );
});

test("POST /api/v1/me/connections/claude surfaces an upstream exchange failure as the same sanitized 500 the existing exchange action produces", async () => {
  const fixture = await buildApiKeyConnectionsFixture();

  globalThis.fetch = (async () =>
    new Response("upstream secret leak: token=abc123", { status: 500 })) as typeof fetch;

  const res = await postRoute(validExchangeBody, `Bearer ${fixture.zeroConnections.apiKey.key}`);
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.error, "Internal server error");
  assert.doesNotMatch(String(body.error), /token=abc123/, "must not leak the upstream error body");
  assert.doesNotMatch(String(body.error), /at \//, "must not leak a stack trace");
});

test("POST /api/v1/me/connections/claude links the exchanged connection and preserves an existing unrelated connection", async () => {
  const fixture = await buildApiKeyConnectionsFixture();
  mockSuccessfulClaudeExchange();

  const res = await postRoute(
    validExchangeBody,
    `Bearer ${fixture.oneNonClaudeConnection.apiKey.key}`
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "linked");
  assert.equal(body.provider, "claude");
  assert.equal(typeof body.connectionId, "string");
  assert.notEqual(body.connectionId, fixture.connections.nonClaudeA.id);

  const row = await apiKeysDb.getApiKeyById(fixture.oneNonClaudeConnection.apiKey.id);
  assert.ok(row, "expected the api key row to still exist");
  const allowed = row?.allowedConnections ?? [];
  assert.ok(
    allowed.includes(fixture.connections.nonClaudeA.id),
    "the pre-existing non-Claude connection must be preserved"
  );
  assert.ok(allowed.includes(body.connectionId), "the newly linked connection must be present");
  assert.equal(allowed.length, 2);
});

test("POST /api/v1/me/connections/claude returns already_linked when the exchanged account is already allowed", async () => {
  const fixture = await buildApiKeyConnectionsFixture();

  // The bootstrap endpoint returns the fixture Claude connection's email so
  // exchangeAndPersistConnection's upsert-by-email path updates the SAME
  // connection id already present in oneClaudeConnection's allowedConnections,
  // instead of creating a new one — exercising the idempotent re-link path.
  globalThis.fetch = (async (url: string | URL | Request) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (href.includes("claude_cli/bootstrap")) {
      return Response.json({
        oauth_account: { account_email: "fixture-claude-user@example.com" },
      });
    }
    return Response.json({
      access_token: "test-access-token-2",
      refresh_token: "test-refresh-token-2",
      expires_in: 3600,
    });
  }) as typeof fetch;

  const res = await postRoute(
    validExchangeBody,
    `Bearer ${fixture.oneClaudeConnection.apiKey.key}`
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "already_linked");
  assert.equal(body.provider, "claude");
  assert.equal(body.connectionId, fixture.connections.claude.id);
});

test("route source never reads a caller-supplied connectionId from the request body", () => {
  const source = fs.readFileSync(routeSourcePath, "utf8");
  assert.doesNotMatch(source, /body\.connectionId/);
  assert.doesNotMatch(source, /\bconnectionId\s*[:,]\s*(rawBody|body)\b/);
});
