import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-claude-setup-401-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const auth = await import("../../src/sse/services/auth.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const TOKEN = "sk-ant-oat01-TESTE0123456789abcdefghijKLMNOP";

test("401 on a claude connection without refreshToken parks it as expired/token_revoked with a clear message", async () => {
  const conn: any = await providersDb.createProviderConnection({
    provider: "claude",
    authType: "oauth",
    name: "setup-token",
    accessToken: TOKEN,
    refreshToken: null,
    expiresAt: null,
    isActive: true,
    testStatus: "active",
    providerSpecificData: { authMethod: "setup_token", scopes: ["user:inference"] },
  });

  await auth.markAccountUnavailable(conn.id, 401, "invalid bearer token", "claude");

  const after: any = await providersDb.getProviderConnectionById(conn.id);
  assert.equal(after.testStatus, "expired");
  assert.equal(after.lastErrorType, "token_revoked");
  assert.match(String(after.lastError), /setup-token/);
  assert.ok(!String(after.lastError).includes(TOKEN));
  assert.equal(Number(after.errorCode), 401);
});

test("401 is terminal even if a legacy row carries a far-future expiresAt but no refreshToken", async () => {
  const conn: any = await providersDb.createProviderConnection({
    provider: "claude",
    authType: "oauth",
    name: "legacy-long-expiry",
    accessToken: TOKEN + "B",
    refreshToken: null,
    expiresAt: new Date(Date.now() + 365 * 86400_000).toISOString(),
    isActive: true,
    testStatus: "active",
  });
  await auth.markAccountUnavailable(conn.id, 401, "invalid bearer token", "claude");
  const after: any = await providersDb.getProviderConnectionById(conn.id);
  assert.equal(after.testStatus, "expired");
  assert.equal(after.lastErrorType, "token_revoked");
});

test("401 on a claude connection WITH refreshToken keeps the normal classification", async () => {
  const conn: any = await providersDb.createProviderConnection({
    provider: "claude",
    authType: "oauth",
    name: "normal-oauth",
    accessToken: "at-normal",
    refreshToken: "rt-normal",
    expiresAt: null,
    isActive: true,
    testStatus: "active",
  });
  await auth.markAccountUnavailable(conn.id, 401, "invalid bearer token", "claude");
  const after: any = await providersDb.getProviderConnectionById(conn.id);
  assert.notEqual(after.lastErrorType, "token_revoked");
});
