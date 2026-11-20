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

interface ConnRow {
  id: string;
  provider?: string;
  authType?: string;
  accessToken?: string;
  refreshToken?: string | null;
  expiresAt?: string | null;
  isActive?: boolean;
  testStatus?: string;
  lastErrorType?: string | null;
  providerSpecificData: Record<string, unknown>;
  [key: string]: unknown;
}

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

  const conn: ConnRow = await providersDb.getProviderConnectionById(body.connectionId);
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

  const conn: ConnRow = await providersDb.getProviderConnectionById(first.connectionId);
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
  const conn: ConnRow = await providersDb.getProviderConnectionById(first.connectionId);
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
  const victim: ConnRow = await providersDb.getProviderConnectionById(
    fixture.connections.claude.id
  );
  assert.notEqual(victim.accessToken, TOKEN);
  assert.notEqual(body.name, "evil");
});

const setupToken = await import("../../../src/lib/oauth/utils/claudeSetupToken.ts");

async function claudeConnectionCount() {
  return (await providersDb.getProviderConnections({ provider: "claude" })).length;
}

test("M1: a setup_token connection owned by another key but linked to this key is NOT overwritten", async () => {
  const fixture = await buildApiKeyConnectionsFixture();
  noNetwork();
  const keyA = fixture.zeroConnections.apiKey;
  const keyB = fixture.oneNonClaudeConnection.apiKey;

  const a = await (await postRoute({ token: TOKEN }, `Bearer ${keyA.key}`)).json();
  const connA: ConnRow = await providersDb.getProviderConnectionById(a.connectionId);
  assert.equal(connA.providerSpecificData.ownerKeyId, keyA.id);

  // The shared connection also ends up in key B's allowedConnections.
  await apiKeysDb.addAllowedConnectionToApiKey(keyB.id, a.connectionId);

  const res = await postRoute({ token: TOKEN_2 }, `Bearer ${keyB.key}`);
  assert.equal(res.status, 201);
  const b = await res.json();
  assert.notEqual(b.connectionId, a.connectionId);

  const after: ConnRow = await providersDb.getProviderConnectionById(a.connectionId);
  assert.equal(after.accessToken, TOKEN, "owner A's token must be untouched");
  const mine: ConnRow = await providersDb.getProviderConnectionById(b.connectionId);
  assert.equal(mine.accessToken, TOKEN_2);
  assert.equal(mine.providerSpecificData.ownerKeyId, keyB.id);
});

test("M2: failing key link removes the freshly created connection and rethrows", async () => {
  const fixture = await buildApiKeyConnectionsFixture();
  const key = fixture.zeroConnections.apiKey;
  const before = await claudeConnectionCount();

  await assert.rejects(
    setupToken.linkClaudeSetupTokenConnection({
      token: TOKEN,
      name: "x",
      ownerKeyId: key.id,
      ownerConnectionIds: [],
      link: async () => {
        throw new Error("SQLITE_BUSY");
      },
    })
  );
  assert.equal(await claudeConnectionCount(), before, "no orphan connection left in the pool");
});

test("M2: link reporting not_found also removes the created connection", async () => {
  const fixture = await buildApiKeyConnectionsFixture();
  const key = fixture.zeroConnections.apiKey;
  const before = await claudeConnectionCount();

  const result = await setupToken.linkClaudeSetupTokenConnection({
    token: TOKEN,
    name: "x",
    ownerKeyId: key.id,
    ownerConnectionIds: [],
    link: async () => ({ status: "not_found" }),
  });
  assert.equal(result.linkStatus, "not_found");
  assert.equal(await claudeConnectionCount(), before);
});

test("M2: failing link on an UPDATE keeps the existing connection", async () => {
  const fixture = await buildApiKeyConnectionsFixture();
  noNetwork();
  const key = fixture.zeroConnections.apiKey;
  const first = await (await postRoute({ token: TOKEN }, `Bearer ${key.key}`)).json();
  const before = await claudeConnectionCount();

  await assert.rejects(
    setupToken.linkClaudeSetupTokenConnection({
      token: TOKEN_2,
      name: "x",
      ownerKeyId: key.id,
      ownerConnectionIds: [first.connectionId],
      link: async () => {
        throw new Error("boom");
      },
    })
  );
  assert.equal(await claudeConnectionCount(), before);
  assert.ok(await providersDb.getProviderConnectionById(first.connectionId));
});

test("B3: env-key is refused with 401", async () => {
  noNetwork();
  const prev = process.env.OMNIROUTE_API_KEY;
  process.env.OMNIROUTE_API_KEY = "env-key-for-setup-token-test";
  try {
    const res = await postRoute({ token: TOKEN }, "Bearer env-key-for-setup-token-test");
    assert.equal(res.status, 401);
  } finally {
    if (prev === undefined) delete process.env.OMNIROUTE_API_KEY;
    else process.env.OMNIROUTE_API_KEY = prev;
  }
});

test("B3: body above 8 KB is rejected with 413 payload_too_large (text length)", async () => {
  const fixture = await buildApiKeyConnectionsFixture();
  const before = await claudeConnectionCount();
  const res = await postRoute(
    { token: TOKEN, pad: "x".repeat(9 * 1024) },
    `Bearer ${fixture.zeroConnections.apiKey.key}`
  );
  assert.equal(res.status, 413);
  assert.deepEqual(await res.json(), { error: "payload_too_large" });
  assert.equal(await claudeConnectionCount(), before);
});

test("B3: declared Content-Length above 8 KB is rejected with 413 before reading", async () => {
  const fixture = await buildApiKeyConnectionsFixture();
  const res = await route.POST(
    new Request("http://localhost/api/v1/me/connections/claude/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(64 * 1024),
        Authorization: `Bearer ${fixture.zeroConnections.apiKey.key}`,
      },
      body: JSON.stringify({ token: TOKEN }),
    })
  );
  assert.equal(res.status, 413);
  assert.deepEqual(await res.json(), { error: "payload_too_large" });
});

test("B3: a body just under the limit still works", async () => {
  const fixture = await buildApiKeyConnectionsFixture();
  noNetwork();
  const res = await postRoute(
    { token: TOKEN, pad: "x".repeat(4 * 1024) },
    `Bearer ${fixture.zeroConnections.apiKey.key}`
  );
  assert.equal(res.status, 201);
});
