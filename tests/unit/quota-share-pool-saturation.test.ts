/**
 * Pool-wide saturation for percent (account-window) dimensions.
 *
 * Before the fix, enforceQuotaShare read the plan-window utilization of the ONE
 * connection serving the request and multiplied it by the pool's account count,
 * then compared that against the pool limit (per-account limit × account count).
 * The account count cancels out, so the "global-saturated" gate really asked
 * "is THIS connection at 100%?" — and blocked the API key with
 * "Provider claude quota window is saturated; no shared capacity available"
 * while the rest of the pool still had headroom.
 *
 * The gate must measure the pool: the mean utilization across its members. The
 * serving connection is read as before; the other members contribute only their
 * cached reading, so one request never fans out into N oauth/usage reads.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-quota-pool-sat-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const poolsDb = await import("../../src/lib/db/quotaPools.ts");
const plansDb = await import("../../src/lib/db/providerPlans.ts");
const satMod = await import("../../src/lib/quota/saturationSignals.ts");
const { enforceQuotaShare } = await import("../../src/lib/quota/enforce.ts");

const PROVIDER = "claude";
const DIM = { unit: "percent" as const, window: "5h" as const };

/** Per-connection 5h utilization (0..100) served by the injected usage fetch. */
const usedByConnection = new Map<string, number>();
const loadedConnections: string[] = [];

satMod.__setAnthropicSaturationDepsForTests({
  loadConnection: async (connectionId: string) => {
    loadedConnections.push(connectionId);
    return { id: connectionId, provider: PROVIDER, authType: "oauth", accessToken: "tok" };
  },
  fetchUsage: async (conn: Record<string, unknown>) => ({
    quotas: { "session (5h)": { used: usedByConnection.get(String(conn.id)) ?? 0 } },
  }),
});

test.after(() => {
  satMod.__setAnthropicSaturationDepsForTests(null);
  core.resetDbInstance();
  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

let poolSeq = 0;
function createPool(members: string[], apiKeyId: string) {
  poolSeq += 1;
  poolsDb.createPool({
    connectionId: members[0],
    connectionIds: members,
    name: `pool-saturation-${poolSeq}`,
    allocations: [{ apiKeyId, weight: 100, policy: "hard" }],
  });
  plansDb.upsertPlan(members[0], PROVIDER, [{ ...DIM, limit: 100 }], "manual");
}

test("a saturated serving connection does not block the key while the pool has headroom", async () => {
  satMod._clearSaturationCache();
  createPool(["a-1", "a-2", "a-3"], "key-a");
  usedByConnection.set("a-1", 100);
  usedByConnection.set("a-2", 10);
  usedByConnection.set("a-3", 0);
  // The other members were read recently by their own traffic.
  await satMod.getSaturation("a-2", PROVIDER, DIM);
  await satMod.getSaturation("a-3", PROVIDER, DIM);

  const decision = await enforceQuotaShare({
    apiKeyId: "key-a",
    connectionId: "a-1",
    provider: PROVIDER,
  });

  assert.equal(decision.kind, "allow", `expected allow, got ${JSON.stringify(decision)}`);
});

test("the key is blocked once every pool member is saturated", async () => {
  satMod._clearSaturationCache();
  createPool(["b-1", "b-2"], "key-b");
  usedByConnection.set("b-1", 100);
  usedByConnection.set("b-2", 100);
  await satMod.getSaturation("b-2", PROVIDER, DIM);

  const decision = await enforceQuotaShare({
    apiKeyId: "key-b",
    connectionId: "b-1",
    provider: PROVIDER,
  });

  assert.equal(decision.kind, "block");
  assert.match(String(decision.kind === "block" && decision.reason), /saturated/);
});

test("other pool members are read from cache only — no per-request fan-out", async () => {
  satMod._clearSaturationCache();
  createPool(["c-1", "c-2", "c-3", "c-4"], "key-c");
  usedByConnection.set("c-1", 20);
  loadedConnections.length = 0;

  await enforceQuotaShare({ apiKeyId: "key-c", connectionId: "c-1", provider: PROVIDER });

  assert.deepEqual([...new Set(loadedConnections)], ["c-1"]);
});

test("peekSaturation returns the cached reading and never fetches", async () => {
  satMod._clearSaturationCache();
  usedByConnection.set("d-1", 40);
  loadedConnections.length = 0;

  assert.equal(satMod.peekSaturation("d-1", PROVIDER, DIM), undefined);
  assert.deepEqual(loadedConnections, []);

  await satMod.getSaturation("d-1", PROVIDER, DIM);
  assert.equal(satMod.peekSaturation("d-1", PROVIDER, DIM), 0.4);
});
