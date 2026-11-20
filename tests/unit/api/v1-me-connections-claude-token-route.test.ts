/**
 * Tests for `POST /api/v1/me/connections/claude/token` — self-service link of a
 * pasted long-lived Claude token (`claude setup-token`, `sk-ant-oat01-...`).
 *
 * Same auth as the sibling `/api/v1/me/connections/claude` (Bearer API key +
 * `self:usage` scope). The owner/name come from the authenticated key only;
 * the body is never allowed to name a connection or owner.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-v1-me-claude-token-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "claude-token-route-test-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../../src/lib/db/core.ts");
const settingsDb = await import("../../../src/lib/db/settings.ts");
const apiKeysDb = await import("../../../src/lib/db/apiKeys.ts");
const providersDb = await import("../../../src/lib/db/providers.ts");
const { buildApiKeyConnectionsFixture } = await import("../../helpers/apiKeyConnectionsFixture.ts");
const route = await import("../../../src/app/api/v1/me/connections/claude/token/route.ts");

const originalFetch = globalThis.fetch;
const TOKEN = "sk-ant-oat01-TESTE0123456789abcdefghijKLMNOP_-xyz";
const TOKEN_2 = "sk-ant-oat01-TESTEsegundoTOKEN0123456789abcdef_-";

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
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  return route.POST(new Request("http://localhost/api/v1/me/connections/claude/token", init));
}

function noNetwork() {
  globalThis.fetch = (async () => {
    throw new Error("network must not be used by the setup-token route");
  }) as typeof fetch;
}

test("rejects a missing Authorization header (401)", async () => {
  const res = await postRoute({ token: TOKEN });
  assert.equal(res.status, 401);
});

test("rejects an invalid Bearer key (401)", async () => {
  const res = await postRoute({ token: TOKEN }, "Bearer not-a-real-key");
  assert.equal(res.status, 401);
});

test("rejects a key lacking self:usage scope (403)", async () => {
  const k = await apiKeysDb.createApiKey("token-no-self-usage", "machine-x", ["manage"]);
  const res = await postRoute({ token: TOKEN }, `Bearer ${k.key}`);
  assert.equal(res.status, 403);
});

for (const [label, body] of [
  ["missing token", {}],
  ["non-string token", { token: 123 }],
  ["wrong prefix", { token: "sk-ant-api03-TESTE0123456789abcdefghij" }],
  ["too short", { token: "sk-ant-oat01-short" }],
  ["bad characters", { token: "sk-ant-oat01-TESTE0123456789abcdef ghij!" }],
  ["invalid json", "{not json"],
] as const) {
  test(`returns 400 invalid_token_format for ${label} without echoing the token`, async () => {
    const fixture = await buildApiKeyConnectionsFixture();
    const res = await postRoute(body, `Bearer ${fixture.zeroConnections.apiKey.key}`);
    assert.equal(res.status, 400);
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), { error: "invalid_token_format" });
    const tokenValue = typeof body === "object" ? (body as { token?: unknown }).token : null;
    if (typeof tokenValue === "string") assert.ok(!text.includes(tokenValue));
  });
}

test("creates a claude oauth connection with no refresh token and no expiry, linked to the key (201)", async () => {
  const fixture = await buildApiKeyConnectionsFixture();
  noNetwork();
  const key = fixture.zeroConnections.apiKey;

  const res = await postRoute({ token: `  ${TOKEN}\n` }, `Bearer ${key.key}`);
  assert.equal(res.status, 201);
  const text = await res.text();
  assert.ok(!text.includes(TOKEN), "response must never contain the token");
  const body = JSON.parse(text);
  assert.equal(body.status, "created");
  assert.equal(body.provider, "claude");
  assert.equal(body.authMethod, "setup_token");
  assert.equal(typeof body.connectionId, "string");
  assert.equal(typeof body.name, "string");

  const conn: any = await providersDb.getProviderConnectionById(body.connectionId);
  assert.equal(conn.provider, "claude");
  assert.equal(conn.authType, "oauth");
  assert.equal(conn.accessToken, TOKEN);
  assert.ok(!conn.refreshToken);
  assert.equal(conn.expiresAt ?? null, null);
  assert.equal(conn.isActive, true);
  assert.deepEqual(conn.providerSpecificData.scopes, ["user:inference"]);
  assert.equal(conn.providerSpecificData.authMethod, "setup_token");
  assert.equal(typeof conn.providerSpecificData.linkedAt, "string");

  const row = await apiKeysDb.getApiKeyById(key.id);
  assert.deepEqual(row?.allowedConnections, [body.connectionId]);
});

test("same key posting again replaces the token on the same connection (idempotent upsert, 200)", async () => {
  const fixture = await buildApiKeyConnectionsFixture();
  noNetwork();
  const bearer = `Bearer ${fixture.oneNonClaudeConnection.apiKey.key}`;

  const first = await (await postRoute({ token: TOKEN }, bearer)).json();
  const res = await postRoute({ token: TOKEN_2 }, bearer);
  assert.equal(res.status, 200);
  const second = await res.json();
  assert.equal(second.status, "updated");
  assert.equal(second.connectionId, first.connectionId);

  const conn: any = await providersDb.getProviderConnectionById(first.connectionId);
  assert.equal(conn.accessToken, TOKEN_2);
  const row = await apiKeysDb.getApiKeyById(fixture.oneNonClaudeConnection.apiKey.id);
  assert.equal(row?.allowedConnections?.length, 2, "unrelated connection preserved, no duplicate");
});

test("re-posting revives a connection parked as expired/token_revoked", async () => {
  const fixture = await buildApiKeyConnectionsFixture();
  noNetwork();
  const bearer = `Bearer ${fixture.zeroConnections.apiKey.key}`;
  const first = await (await postRoute({ token: TOKEN }, bearer)).json();
  await providersDb.updateProviderConnection(first.connectionId, {
    testStatus: "expired",
    lastErrorType: "token_revoked",
    lastError: "revoked",
    errorCode: 401,
  });
  await postRoute({ token: TOKEN_2 }, bearer);
  const conn: any = await providersDb.getProviderConnectionById(first.connectionId);
  assert.equal(conn.testStatus, "active");
  assert.ok(!conn.lastErrorType);
  assert.equal(conn.isActive, true);
});

test("never reads connectionId or owner from the body", async () => {
  const fixture = await buildApiKeyConnectionsFixture();
  noNetwork();
  const res = await postRoute(
    { token: TOKEN, connectionId: fixture.connections.claude.id, name: "evil", owner: "x" },
    `Bearer ${fixture.zeroConnections.apiKey.key}`
  );
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.notEqual(body.connectionId, fixture.connections.claude.id);
  const victim: any = await providersDb.getProviderConnectionById(fixture.connections.claude.id);
  assert.notEqual(victim.accessToken, TOKEN);
  assert.notEqual(body.name, "evil");
});
