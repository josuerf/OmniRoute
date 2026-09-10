const MODEL_PERMISSION_CACHE_TTL = 60 * 1000;

/**
 * Entry cap for the per-key model-permission memo. Override with
 * `OMNIROUTE_MODEL_PERMISSION_CACHE_MAX`.
 *
 * Sized from one full `GET /v1/models` pass: the catalog filter calls
 * `isModelAllowedForKey()` twice per model (the prefixed id and the raw root), so a
 * 2 645-model catalog needs ~5 290 distinct memo keys for a single API key. The cap
 * was 1 000, which could not hold even one pass, so each pass evicted its own earliest
 * entries and the memo never returned a hit across rebuilds: every rebuild recomputed
 * every permission from scratch, resolving alias candidates per model and reading
 * SQLite for keys that set `disableNonPublicModels`. With one entry costing roughly
 * 220 bytes (key string plus record plus Map overhead), 60 000 entries is about 13 MB
 * of heap and holds ~11 actively polling keys, which is the case this cache is for: a
 * development team where every member polls with their own key (IAF-477).
 */
export const MODEL_PERMISSION_CACHE_MAX_ENTRIES = (() => {
  const parsed = Number.parseInt(process.env.OMNIROUTE_MODEL_PERMISSION_CACHE_MAX ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60_000;
})();

/** Share of the cap released per eviction, so trimming stays amortized O(1). */
const EVICTION_BATCH_RATIO = 0.2;

interface ModelPermissionCacheValue {
  allowed: boolean;
  timestamp: number;
  generation: number;
}

const _modelPermissionCache = new Map<string, ModelPermissionCacheValue>();

function isFresh(
  entry: ModelPermissionCacheValue,
  now: number,
  currentGeneration: number
): boolean {
  if (entry.generation !== currentGeneration) return false;
  if (now - entry.timestamp >= MODEL_PERMISSION_CACHE_TTL) return false;
  return true;
}

export function getCachedModelPermission(
  cacheKey: string,
  now: number,
  catalogGeneration: number
): boolean | undefined {
  const entry = _modelPermissionCache.get(cacheKey);
  if (!entry) return undefined;

  if (!isFresh(entry, now, catalogGeneration)) {
    _modelPermissionCache.delete(cacheKey);
    return undefined;
  }

  return entry.allowed;
}

export function setCachedModelPermission(
  cacheKey: string,
  allowed: boolean,
  now: number,
  catalogGeneration: number
): void {
  _modelPermissionCache.set(cacheKey, {
    allowed,
    timestamp: now,
    generation: catalogGeneration,
  });
  // Enforced here as well as at the caller, so the bound cannot be lost by a write
  // path that forgets to call evictModelPermissionCache() first.
  evictModelPermissionCache();
}

/**
 * Trim the memo back under its cap.
 *
 * Returns immediately while under the cap, so the catalog filter's thousands of writes
 * per rebuild do not pay for a scan. Over the cap, entries are dropped oldest-first:
 * nothing re-inserts on read, so insertion order is age order, and the oldest entries
 * are also the ones nearest their TTL.
 */
export function evictModelPermissionCache(): void {
  if (_modelPermissionCache.size <= MODEL_PERMISSION_CACHE_MAX_ENTRIES) return;
  const entriesToRemove = Math.max(
    1,
    Math.floor(MODEL_PERMISSION_CACHE_MAX_ENTRIES * EVICTION_BATCH_RATIO)
  );
  let i = 0;
  for (const key of _modelPermissionCache.keys()) {
    if (i++ >= entriesToRemove) break;
    _modelPermissionCache.delete(key);
  }
}

export function clearModelPermissionCache(): void {
  _modelPermissionCache.clear();
}

/** Not part of the public API; lets a test assert the cap actually holds. */
export function __getModelPermissionCacheSizeForTest(): number {
  return _modelPermissionCache.size;
}
