/**
 * IAF-477 — the two `GET /v1/models` response memos must stay bounded.
 *
 * `catalogLastGood` had no production prune path (its only `.clear()` lives in a test
 * hook) and `catalogCache` was only ever dropped wholesale when the catalog generation
 * moved, so both grew one ~1.3 MB entry per distinct cache key (one per API key ×
 * client × flag combination) and never shrank in between. On the production gateway
 * that showed up as heap climbing all day until the chat admission guard started
 * shedding with 503s.
 *
 * The bound is on BYTES, not entry count: a restricted key's catalog is a fraction of
 * the full one, so an entry cap would either waste the budget on small bodies or evict
 * a live key and force the ~49 s rebuild the memo exists to avoid.
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-catalog-bounded-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const catalogCache = await import("../../src/app/api/v1/models/catalogCache.ts");

/** Stand-in for one serialized catalog. Small enough to keep the test fast. */
const BODY_BYTES = 8 * 1024;
const BUDGET_BODIES = 8;

function body(i: number): string {
  return `${i}:`.padEnd(BODY_BYTES, "x");
}

function request(i: number): Request {
  return new Request(`http://localhost/v1/models?prefix=p${i}`);
}

function payload(i: number): catalogCache.CatalogPayload {
  return { body: body(i), headers: {}, status: 200, cacheTTL: 60_000 };
}

function resolve(i: number, build: () => Promise<catalogCache.CatalogPayload>) {
  return catalogCache.resolveCachedCatalogResponse(
    request(i),
    { corsHeaders: {}, diagnosticHeaders: {} },
    build
  );
}

test.beforeEach(() => {
  process.env.CATALOG_CACHE_MAX_BYTES = String(BUDGET_BODIES * BODY_BYTES);
  catalogCache.__resetCatalogBuilderRunsForTest();
});

test.afterEach(() => {
  delete process.env.CATALOG_CACHE_MAX_BYTES;
});

test("IAF-477 many distinct cache keys keep both catalog memos inside the byte budget", async () => {
  const distinctKeys = BUDGET_BODIES * 8;
  for (let i = 0; i < distinctKeys; i++) {
    await resolve(i, async () => payload(i));
  }

  const budget = BUDGET_BODIES * BODY_BYTES;
  const sizes = catalogCache.__getCatalogCacheSizesForTest();
  assert.ok(
    sizes.cacheBytes <= budget,
    `catalogCache held ${sizes.cacheBytes} bytes over a ${budget} byte budget`
  );
  assert.ok(
    sizes.lastGoodBytes <= budget,
    `catalogLastGood held ${sizes.lastGoodBytes} bytes over a ${budget} byte budget`
  );
});

test("IAF-477 eviction is least-recently-used, so an actively polled key survives a flood", async () => {
  for (let i = 0; i < BUDGET_BODIES; i++) {
    await resolve(i, async () => payload(i));
  }
  assert.equal(catalogCache.__getCatalogBuilderRunsForTest(), BUDGET_BODIES);

  // Read key 0 so it becomes the most recently used entry, then push one new key in.
  await resolve(0, async () => payload(0));
  assert.equal(catalogCache.__getCatalogBuilderRunsForTest(), BUDGET_BODIES, "key 0 was cached");

  await resolve(BUDGET_BODIES, async () => payload(BUDGET_BODIES));
  assert.equal(catalogCache.__getCatalogBuilderRunsForTest(), BUDGET_BODIES + 1);

  // Key 0 was touched, so the flood must have taken key 1 (the true LRU) instead.
  await resolve(0, async () => payload(0));
  assert.equal(
    catalogCache.__getCatalogBuilderRunsForTest(),
    BUDGET_BODIES + 1,
    "the recently used key 0 must not have been evicted"
  );

  await resolve(1, async () => payload(1));
  assert.equal(
    catalogCache.__getCatalogBuilderRunsForTest(),
    BUDGET_BODIES + 2,
    "key 1 was the least recently used and must have been the one evicted"
  );
});

test("IAF-477 an entry larger than the whole budget is still served from cache", async () => {
  // A budget below one catalog must degrade to "keep one entry", never to "cache
  // nothing": rebuilding on every request is the failure mode the memo exists to
  // prevent, and it is what the v3.8.8 outage looked like from the client side.
  process.env.CATALOG_CACHE_MAX_BYTES = "1";

  await resolve(0, async () => payload(0));
  await resolve(0, async () => payload(0));

  assert.equal(catalogCache.__getCatalogBuilderRunsForTest(), 1);
  assert.equal(catalogCache.__getCatalogCacheSizesForTest().cacheEntries, 1);
});
