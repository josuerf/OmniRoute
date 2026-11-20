/**
 * Security tests for `POST /api/v1/me/connections/claude/token`:
 * encryption at rest, no token leakage (audit, logs, responses, errors) and
 * concurrent pastes with the same API key.
 */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-claude-token-sec-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "claude-token-security-test-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
// Generated in-process, only for this test run; never written to a file.
const previousEncryptionKey = process.env.STORAGE_ENCRYPTION_KEY;
process.env.STORAGE_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");

const core = await import("../../src/lib/db/core.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const { buildApiKeyConnectionsFixture } = await import("../helpers/apiKeyConnectionsFixture.ts");
const route = await import("../../src/app/api/v1/me/connections/claude/token/route.ts");

const TOKEN = "sk-ant-oat01-TESTEsegredo0123456789abcdefghij_-XYZ";
const TOKEN_2 = "sk-ant-oat01-TESTEoutroSEGREDO9876543210zyxwvu_-QRS";
const TOKEN_3 = "sk-ant-oat01-TESTEterceiroSEGREDO1122334455aabbcc_-LMN";
const originalFetch = globalThis.fetch;

test.before(async () => {
  await settingsDb.updateSettings({ requireLogin: false });
});

test.after(() => {
  globalThis.fetch = originalFetch;
  if (previousEncryptionKey === undefined) delete process.env.STORAGE_ENCRYPTION_KEY;
  else process.env.STORAGE_ENCRYPTION_KEY = previousEncryptionKey;
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

function postRoute(body: unknown, bearer?: string, extraHeaders: Record<string, string> = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...extraHeaders };
  if (bearer !== undefined) headers.Authorization = bearer;
  const init: RequestInit = { method: "POST", headers };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  return route.POST(new Request("http://localhost/api/v1/me/connections/claude/token", init));
}

/** Every secret fragment that must never leak: the token and long substrings of it. */
function fragments(token: string): string[] {
  const secret = token.slice("sk-ant-oat01-".length);
  return [token, secret, secret.slice(0, 16), secret.slice(-16)];
}

function assertNoLeak(haystack: string, token: string, where: string) {
  for (const f of fragments(token)) {
    assert.ok(!haystack.includes(f), `${where} leaks "${f.slice(0, 8)}..."`);
  }
}

/** Dump every text/blob cell of every table except `skipTables`. */
function dumpDb(skipTables: string[] = []): string {
  const db = core.getDbInstance();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;
  const out: string[] = [];
  for (const { name } of tables) {
    if (skipTables.includes(name)) continue;
    const rows = db.prepare(`SELECT * FROM "${name}"`).all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      for (const value of Object.values(row)) {
        if (typeof value === "string") out.push(value);
        else if (Buffer.isBuffer(value)) out.push(value.toString("utf8"));
      }
    }
  }
  return out.join("\n");
}

function captureConsole() {
  const lines: string[] = [];
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    info: console.info,
  };
  const grab = (...args: unknown[]) => {
    lines.push(
      args
        .map((a) =>
          typeof a === "string" ? a : a instanceof Error ? a.stack || a.message : JSON.stringify(a)
        )
        .join(" ")
    );
  };
  console.log = grab;
  console.warn = grab;
  console.error = grab;
  console.info = grab;
  return {
    lines,
    restore() {
      Object.assign(console, original);
    },
  };
}

test("access token is encrypted at rest and decrypted by the DB layer", async () => {
  const fixture = await buildApiKeyConnectionsFixture();
  const res = await postRoute({ token: TOKEN }, `Bearer ${fixture.zeroConnections.apiKey.key}`);
  assert.equal(res.status, 201);
  const { connectionId } = await res.json();

  const raw = core
    .getDbInstance()
    .prepare("SELECT * FROM provider_connections WHERE id = ?")
    .get(connectionId) as Record<string, unknown>;
  assert.ok(raw, "row exists");
  const rawText = JSON.stringify(raw);
  assertNoLeak(rawText, TOKEN, "raw provider_connections row");
  const stored = String(raw.access_token);
  assert.ok(stored.startsWith("enc:v1:"), "ciphertext carries the repo prefix");

  const conn = await providersDb.getProviderConnectionById(connectionId);
  assert.equal((conn as { accessToken?: string }).accessToken, TOKEN);
  assertNoLeak(dumpDb(), TOKEN, "whole database dump");
});

test("audit log, console output and responses never contain the token", async () => {
  const fixture = await buildApiKeyConnectionsFixture();
  const bearer = `Bearer ${fixture.zeroConnections.apiKey.key}`;
  const cap = captureConsole();
  const bodies: string[] = [];
  try {
    for (const token of [TOKEN, TOKEN_2]) {
      const res = await postRoute({ token }, bearer);
      assert.ok([200, 201].includes(res.status));
      bodies.push(await res.text());
    }
    // 400 / 401 / 413 responses
    const bad = await postRoute({ token: `${TOKEN}!bad` }, bearer);
    assert.equal(bad.status, 400);
    bodies.push(await bad.text());
    const unauth = await postRoute({ token: TOKEN }, "Bearer nope");
    assert.equal(unauth.status, 401);
    bodies.push(await unauth.text());
    const big = await postRoute(JSON.stringify({ token: TOKEN, pad: "x".repeat(9000) }), bearer);
    assert.equal(big.status, 413);
    bodies.push(await big.text());
    const bigHeader = await postRoute({ token: TOKEN }, bearer, { "Content-Length": "99999" });
    assert.equal(bigHeader.status, 413);
    bodies.push(await bigHeader.text());
  } finally {
    cap.restore();
  }

  for (const token of [TOKEN, TOKEN_2]) {
    for (const body of bodies) assertNoLeak(body, token, "HTTP body");
    assertNoLeak(cap.lines.join("\n"), token, "console output");
  }

  const audit = core.getDbInstance().prepare("SELECT * FROM audit_log").all();
  assert.ok(
    audit.some((r) => (r as { action: string }).action === "apiKey.connections.link"),
    "link event is audited"
  );
  const auditText = JSON.stringify(audit);
  for (const token of [TOKEN, TOKEN_2]) assertNoLeak(auditText, token, "audit_log");
});

test("a simulated 500 returns a generic error and logs no token", async () => {
  const fixture = await buildApiKeyConnectionsFixture();
  const bearer = `Bearer ${fixture.zeroConnections.apiKey.key}`;
  const db = core.getDbInstance();
  db.exec(
    "CREATE TRIGGER fail_claude_insert BEFORE INSERT ON provider_connections BEGIN SELECT RAISE(ABORT, 'boom'); END"
  );
  const cap = captureConsole();
  let res: Response;
  try {
    res = await postRoute({ token: TOKEN_3 }, bearer);
  } finally {
    cap.restore();
    db.exec("DROP TRIGGER IF EXISTS fail_claude_insert");
  }
  assert.equal(res.status, 500);
  const text = await res.text();
  assert.deepEqual(JSON.parse(text), { error: "Internal server error" });
  assertNoLeak(text, TOKEN_3, "500 body");
  assertNoLeak(cap.lines.join("\n"), TOKEN_3, "console output on 500");
  assertNoLeak(JSON.stringify(db.prepare("SELECT * FROM audit_log").all()), TOKEN_3, "audit_log");
});

test("two simultaneous pastes with the same key yield a single claude connection", async () => {
  const fixture = await buildApiKeyConnectionsFixture();
  const key = fixture.zeroConnections.apiKey;
  const bearer = `Bearer ${key.key}`;

  const [a, b] = await Promise.all([
    postRoute({ token: TOKEN }, bearer),
    postRoute({ token: TOKEN_2 }, bearer),
  ]);
  assert.ok([200, 201].includes(a.status), `first status ${a.status}`);
  assert.ok([200, 201].includes(b.status), `second status ${b.status}`);
  const ja = await a.json();
  const jb = await b.json();
  assert.equal(ja.connectionId, jb.connectionId, "same connection for both calls");
  assert.deepEqual([a.status, b.status].sort(), [200, 201], "one created, one updated");

  const owned = (await providersDb.getProviderConnections({ provider: "claude" })).filter(
    (c) =>
      (c as { providerSpecificData?: { ownerKeyId?: string } }).providerSpecificData?.ownerKeyId ===
      key.id
  );
  assert.equal(owned.length, 1, "exactly one setup-token connection for the owner");
  const final = (owned[0] as { accessToken: string }).accessToken;
  assert.ok([TOKEN, TOKEN_2].includes(final), "stored token is one of the two submitted");

  const links = await apiKeysDb.getApiKeyMetadata(key.key);
  const linked = (links?.allowedConnections ?? []).filter((id: string) => id === ja.connectionId);
  assert.equal(linked.length, 1, "linked exactly once");
});

test("re-link drops the old token's quota and probe state", async () => {
  const quotaMod = await import("../../src/lib/quota/claudeHeaderQuota.ts");
  const fixture = await buildApiKeyConnectionsFixture();
  const bearer = `Bearer ${fixture.zeroConnections.apiKey.key}`;

  const first = await postRoute({ token: TOKEN }, bearer);
  assert.ok([200, 201].includes(first.status));
  const { connectionId } = await first.json();

  const conn = (await providersDb.getProviderConnectionById(connectionId)) as {
    providerSpecificData: Record<string, unknown>;
  };
  await providersDb.updateProviderConnection(connectionId, {
    providerSpecificData: {
      ...conn.providerSpecificData,
      lastRateLimit: { observedAt: 1, status: "allowed" },
      lastProbeAt: "2026-01-01T00:00:00.000Z",
      lastProbeStatus: 200,
    },
  });
  quotaMod.recordClaudeHeaderQuota(
    connectionId,
    new Headers({ "anthropic-ratelimit-unified-5h-utilization": "0.5" }),
    Date.now(),
    { providerSpecificData: conn.providerSpecificData, persist: () => {}, feedCache: () => {} }
  );
  assert.ok(quotaMod.getClaudeHeaderQuota(connectionId), "memory reading primed");

  const second = await postRoute({ token: TOKEN_3 }, bearer);
  assert.equal(second.status, 200);
  const after = (await providersDb.getProviderConnectionById(connectionId)) as {
    providerSpecificData: Record<string, unknown>;
  };
  assert.equal(after.providerSpecificData.lastRateLimit, undefined);
  assert.equal(after.providerSpecificData.lastProbeAt, undefined);
  assert.equal(after.providerSpecificData.lastProbeStatus, undefined);
  assert.equal(after.providerSpecificData.authMethod, "setup_token");
  assert.equal(quotaMod.getClaudeHeaderQuota(connectionId), null);
});
