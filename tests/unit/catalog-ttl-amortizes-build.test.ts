/**
 * IAF-477 — the catalog TTL must amortize the build cost across a whole team.
 *
 * `tests/unit/v1-models-catalog-ttl.test.ts` already pins that the TTL has to outlive a
 * realistic gap between polls. This file pins the arithmetic that the production
 * incident exposed, which a single-client gap check cannot see.
 *
 * The catalog cache key includes the API key fingerprint, and it has to: the catalog is
 * filtered per key (`catalog.ts`, `isModelAllowedForKey`). So every developer polling
 * with their own key owns a separate cache entry with its own TTL, and each one pays a
 * full rebuild when that TTL expires. With the measured ~49 s build and a 60 s TTL,
 * one key alone kept a core busy 82 % of the time; a team of five saturated the process
 * permanently, which is how the gateway ended up shedding chat requests with 503s while
 * the heap stayed full of catalog build garbage.
 *
 * Post-write freshness does not depend on the TTL: every write that feeds the builder
 * moves `modelCatalogCacheVersion` (settings, connections, combos, pricing, nodes,
 * capability and context overrides, aliases, compat entries, synced models, feature
 * flags, and per-key permission changes), and `dropCatalogCacheIfStateChanged()` drops
 * the whole cache the moment it moves. The TTL only governs the "nothing was written"
 * case, so its length trades rebuild frequency against nothing but how old a catalog
 * can be when no state has changed at all.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-catalog-ttl-amort-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const catalogCache = await import("../../src/app/api/v1/models/catalogCache.ts");

/** Measured 2026-07-28 on the production VPS: 1.3 MB / 2645-model catalog. */
const MEASURED_BUILD_MS = 49_000;

/** Team size the gateway is expected to serve, each polling with its own API key. */
const CONCURRENT_KEYS = 10;

/**
 * Share of one CPU that catalog rebuilds may consume in steady state. The gateway also
 * has to translate and stream chat traffic on the same single-threaded runtime, so
 * rebuilds cannot be allowed to take the whole core.
 */
const MAX_CORE_SHARE = 0.9;

test("IAF-477 the default TTL keeps a whole team's catalog rebuilds under one core", () => {
  const dutyCyclePerKey = MEASURED_BUILD_MS / catalogCache.CATALOG_CACHE_TTL_MS_DEFAULT;
  const totalCoreShare = dutyCyclePerKey * CONCURRENT_KEYS;

  assert.ok(
    totalCoreShare <= MAX_CORE_SHARE,
    `a ${catalogCache.CATALOG_CACHE_TTL_MS_DEFAULT} ms TTL makes ${CONCURRENT_KEYS} polling ` +
      `keys spend ${(totalCoreShare * 100).toFixed(0)} % of a core rebuilding the catalog ` +
      `(${MEASURED_BUILD_MS} ms per rebuild, one rebuild per key per TTL)`
  );
});

test("IAF-477 the settings ceiling lets an operator tune past the shipped default", async () => {
  const { databaseSettingsSchema } = await import("../../src/shared/validation/settingsSchemas.ts");
  const field = databaseSettingsSchema.shape.cache.shape.modelCatalogCacheTtlMs;

  // A deployment with a larger catalog than the one measured above needs headroom above
  // whatever default ships, otherwise the only remaining lever is serving fewer models.
  const halfHour = 30 * 60_000;
  assert.ok(
    field.safeParse(halfHour).success,
    `settings schema rejects a ${halfHour} ms TTL, so an operator whose build is slower ` +
      `than the measured one cannot configure their way out of the rebuild storm`
  );

  // The floor stays low so a developer can still force near-immediate rebuilds locally.
  assert.ok(field.safeParse(500).success, "the existing 500 ms floor must stay configurable");
  assert.ok(!field.safeParse(0).success, "a zero TTL would disable the cache entirely");
});
