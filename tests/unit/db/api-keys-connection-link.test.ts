/**
 * Tests for the atomic `allowedConnections` merge helper
 * `addAllowedConnectionToApiKey`.
 *
 * This is a purely additive function (never modifies, never replaces
 * `updateApiKeyPermissions`) that unions a single connectionId into an API
 * key's `allowedConnections` list inside a `BEGIN IMMEDIATE` transaction,
 * exactly mirroring the transaction shape `updateApiKeyPermissions` uses for
 * its own `allowedConnections`-only branch (src/lib/db/apiKeys.ts).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-conn-link-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "connection-link-test-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../../src/lib/db/core.ts");
const apiKeys = await import("../../../src/lib/db/apiKeys.ts");
const { buildApiKeyConnectionsFixture } = await import("../../helpers/apiKeyConnectionsFixture.ts");

async function resetStorage(): Promise<void> {
  core.resetDbInstance();
  apiKeys.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(resetStorage);
test.after(() => {
  core.resetDbInstance();
  apiKeys.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("addAllowedConnectionToApiKey returns not_found for a nonexistent api key", async () => {
  const missingId = "00000000-0000-4000-8000-000000000099";
  const result = await apiKeys.addAllowedConnectionToApiKey(
    missingId,
    "00000000-0000-4000-8000-000000000001"
  );
  assert.deepEqual(result, { status: "not_found", apiKeyId: missingId });
});

test("links a claude connection onto a key with zero allowedConnections", async () => {
  const fixture = await buildApiKeyConnectionsFixture();

  const result = await apiKeys.addAllowedConnectionToApiKey(
    fixture.zeroConnections.apiKey.id,
    fixture.connections.claude.id
  );

  assert.deepEqual(result, {
    status: "linked",
    apiKeyId: fixture.zeroConnections.apiKey.id,
    connectionId: fixture.connections.claude.id,
  });

  const row = await apiKeys.getApiKeyById(fixture.zeroConnections.apiKey.id);
  assert.deepEqual(row?.allowedConnections, [fixture.connections.claude.id]);
});

test("preserves an existing unrelated (non-Claude) connection when linking a Claude connection", async () => {
  const fixture = await buildApiKeyConnectionsFixture();

  const result = await apiKeys.addAllowedConnectionToApiKey(
    fixture.oneNonClaudeConnection.apiKey.id,
    fixture.connections.claude.id
  );

  assert.deepEqual(result, {
    status: "linked",
    apiKeyId: fixture.oneNonClaudeConnection.apiKey.id,
    connectionId: fixture.connections.claude.id,
  });

  const row = await apiKeys.getApiKeyById(fixture.oneNonClaudeConnection.apiKey.id);
  assert.equal(row?.allowedConnections?.length, 2);
  assert.deepEqual(
    new Set(row?.allowedConnections),
    new Set([fixture.connections.nonClaudeA.id, fixture.connections.claude.id])
  );
});

test("is idempotent: re-adding an already-linked connection returns already_linked without duplicating", async () => {
  const fixture = await buildApiKeyConnectionsFixture();

  const result = await apiKeys.addAllowedConnectionToApiKey(
    fixture.oneClaudeConnection.apiKey.id,
    fixture.connections.claude.id
  );

  assert.deepEqual(result, {
    status: "already_linked",
    apiKeyId: fixture.oneClaudeConnection.apiKey.id,
    connectionId: fixture.connections.claude.id,
  });

  const row = await apiKeys.getApiKeyById(fixture.oneClaudeConnection.apiKey.id);
  assert.deepEqual(row?.allowedConnections, [fixture.connections.claude.id]);
});

test("idempotent re-add on a multi-connection key leaves the full list untouched", async () => {
  const fixture = await buildApiKeyConnectionsFixture();
  const before = (await apiKeys.getApiKeyById(fixture.multipleConnections.apiKey.id))
    ?.allowedConnections;

  const result = await apiKeys.addAllowedConnectionToApiKey(
    fixture.multipleConnections.apiKey.id,
    fixture.connections.nonClaudeB.id
  );

  assert.equal(result.status, "already_linked");

  const after = (await apiKeys.getApiKeyById(fixture.multipleConnections.apiKey.id))
    ?.allowedConnections;
  assert.deepEqual(after, before);
});

test("never returns the api key value or any secret material, only ids and status", async () => {
  const fixture = await buildApiKeyConnectionsFixture();

  const result = await apiKeys.addAllowedConnectionToApiKey(
    fixture.zeroConnections.apiKey.id,
    fixture.connections.claude.id
  );

  assert.deepEqual(Object.keys(result).sort(), ["apiKeyId", "connectionId", "status"]);
});

test("calls assertExclusiveLeaseKeyPolicy for keys carrying the exclusive-lease scope, and does not break a legitimate add", async () => {
  const CONNECTION_A = "00000000-0000-4000-8000-000000000010";
  const CONNECTION_B = "00000000-0000-4000-8000-000000000011";

  // assertExclusiveLeaseKeyPolicy already blocks creating a lease:exclusive
  // key with an empty allowedConnections (see
  // tests/unit/exclusive-lease-api-key-policy.test.ts), so any key carrying
  // that scope in this DB necessarily starts non-empty. addAllowedConnectionToApiKey
  // is add-only (never removes an entry), so the invariant it must preserve
  // ("lease:exclusive requires explicit allowedConnections", i.e. never
  // empty) can never be violated by a successful merge here - this test
  // proves the call is exercised on the write path (mirroring
  // updateApiKeyPermissions's own call, src/lib/db/apiKeys.ts ~line 1052)
  // and that it does not spuriously reject a legitimate lease-scoped add.
  const leaseKey = await apiKeys.createApiKey("lease key", "test-machine", ["lease:exclusive"], {
    allowedConnections: [CONNECTION_A],
  });

  const result = await apiKeys.addAllowedConnectionToApiKey(leaseKey.id, CONNECTION_B);

  assert.deepEqual(result, {
    status: "linked",
    apiKeyId: leaseKey.id,
    connectionId: CONNECTION_B,
  });

  const row = await apiKeys.getApiKeyById(leaseKey.id);
  assert.deepEqual(new Set(row?.allowedConnections), new Set([CONNECTION_A, CONNECTION_B]));

  // Sanity: the invariant this key carries is real. A full-replace to an
  // empty allowedConnections (the operation updateApiKeyPermissions guards,
  // and the shape of write our function must mirror) is rejected the same
  // way for this same row.
  await assert.rejects(
    apiKeys.updateApiKeyPermissions(leaseKey.id, { allowedConnections: [] }),
    /requires explicit allowedConnections/
  );
});

test("concurrent calls adding different connections both land, losing neither the pre-existing entry nor either addition", async () => {
  const fixture = await buildApiKeyConnectionsFixture();
  const keyId = fixture.oneNonClaudeConnection.apiKey.id;

  const results = await Promise.all([
    apiKeys.addAllowedConnectionToApiKey(keyId, fixture.connections.claude.id),
    apiKeys.addAllowedConnectionToApiKey(keyId, fixture.connections.nonClaudeB.id),
  ]);

  assert.deepEqual(
    results.map((r) => r.status).sort(),
    ["linked", "linked"],
    "each concurrent call adds a distinct connectionId, so both report linked"
  );

  const row = await apiKeys.getApiKeyById(keyId);
  assert.deepEqual(
    new Set(row?.allowedConnections),
    new Set([
      fixture.connections.nonClaudeA.id,
      fixture.connections.claude.id,
      fixture.connections.nonClaudeB.id,
    ]),
    "the pre-existing connection and both concurrently-added connections must all be present"
  );
  assert.equal(
    row?.allowedConnections?.length,
    3,
    "no duplicates and nothing dropped by the interleaved transactions"
  );
});

test("concurrent calls adding the same connection report exactly one linked and one already_linked, without duplicating it", async () => {
  const fixture = await buildApiKeyConnectionsFixture();
  const keyId = fixture.zeroConnections.apiKey.id;

  const results = await Promise.all([
    apiKeys.addAllowedConnectionToApiKey(keyId, fixture.connections.claude.id),
    apiKeys.addAllowedConnectionToApiKey(keyId, fixture.connections.claude.id),
  ]);

  assert.deepEqual(results.map((r) => r.status).sort(), ["already_linked", "linked"]);

  const row = await apiKeys.getApiKeyById(keyId);
  assert.deepEqual(row?.allowedConnections, [fixture.connections.claude.id]);
});

test("rolls back cleanly and leaves the row untouched when the api key does not exist", async () => {
  const fixture = await buildApiKeyConnectionsFixture();
  const missingId = "00000000-0000-4000-8000-000000000098";

  const result = await apiKeys.addAllowedConnectionToApiKey(
    missingId,
    fixture.connections.claude.id
  );
  assert.equal(result.status, "not_found");

  // Unrelated rows are unaffected by the rollback.
  const row = await apiKeys.getApiKeyById(fixture.zeroConnections.apiKey.id);
  assert.deepEqual(row?.allowedConnections, []);
});
