/**
 * IAF-477 — the model-permission memo must survive one full catalog pass.
 *
 * `GET /v1/models` filters the catalog per API key with two `isModelAllowedForKey()`
 * lookups per model (the prefixed id and the raw root), so one pass over a
 * 2 645-model catalog needs ~5 290 distinct memo keys. The cap was 1 000 with
 * `evictModelPermissionCache()` running on every miss, so a pass evicted its own
 * earliest entries long before the next rebuild could reuse them: the memo could
 * never return a hit across builds, and every rebuild recomputed every permission
 * from scratch (each one resolving alias candidates, and hitting SQLite when the key
 * has `disableNonPublicModels` set).
 */
import assert from "node:assert/strict";
import test from "node:test";

const {
  getCachedModelPermission,
  setCachedModelPermission,
  evictModelPermissionCache,
  clearModelPermissionCache,
  MODEL_PERMISSION_CACHE_MAX_ENTRIES,
  __getModelPermissionCacheSizeForTest,
} = await import("../../src/lib/db/apiKeys/modelPermissionCache.ts");

/** Two lookups per model over a catalog the size of the production one. */
const FULL_PASS_ENTRIES = 2645 * 2;
const GENERATION = 1;

test.beforeEach(() => {
  clearModelPermissionCache();
});

test("IAF-477 one full catalog pass fits without evicting its own earliest entries", () => {
  const now = Date.now();

  // Mirrors the production write path exactly (apiKeys.ts: evict, then set).
  for (let i = 0; i < FULL_PASS_ENTRIES; i++) {
    evictModelPermissionCache();
    setCachedModelPermission(`key-a:model-${i}`, true, now, GENERATION);
  }

  assert.equal(
    getCachedModelPermission("key-a:model-0", now, GENERATION),
    true,
    "the first model of the pass must still be cached when the pass ends"
  );
  assert.equal(
    getCachedModelPermission(`key-a:model-${FULL_PASS_ENTRIES - 1}`, now, GENERATION),
    true
  );
});

test("IAF-477 the cap holds several active keys, not just one", () => {
  // Every developer polling with their own API key adds a full pass of its own.
  assert.ok(
    MODEL_PERMISSION_CACHE_MAX_ENTRIES >= FULL_PASS_ENTRIES * 5,
    `cap ${MODEL_PERMISSION_CACHE_MAX_ENTRIES} cannot hold five keys × ${FULL_PASS_ENTRIES} entries`
  );
});

test("IAF-477 the cap is still enforced, so the memo cannot grow without bound", () => {
  const now = Date.now();
  const overflow = MODEL_PERMISSION_CACHE_MAX_ENTRIES + 5_000;

  for (let i = 0; i < overflow; i++) {
    evictModelPermissionCache();
    setCachedModelPermission(`flood:model-${i}`, true, now, GENERATION);
  }

  assert.ok(
    __getModelPermissionCacheSizeForTest() <= MODEL_PERMISSION_CACHE_MAX_ENTRIES,
    `memo held ${__getModelPermissionCacheSizeForTest()} entries over a ${MODEL_PERMISSION_CACHE_MAX_ENTRIES} cap`
  );
});

test("IAF-477 expired entries are dropped before live ones", () => {
  const now = Date.now();
  // One stale entry (older than the 60 s TTL) plus one fresh entry.
  setCachedModelPermission("stale:model", true, now - 120_000, GENERATION);
  setCachedModelPermission("fresh:model", true, now, GENERATION);

  evictModelPermissionCache();

  assert.equal(getCachedModelPermission("fresh:model", now, GENERATION), true);
  assert.equal(
    getCachedModelPermission("stale:model", now, GENERATION),
    undefined,
    "an entry past its TTL must never be served"
  );
});
