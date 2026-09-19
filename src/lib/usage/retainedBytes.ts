/**
 * Shared payload-size estimator for the in-memory request caches.
 *
 * It is an ESTIMATE of the strings and object fields a cache entry keeps
 * reachable, not a process-memory measurement: fixed costs stand in for object
 * and array headers, and a `WeakSet` keeps a cyclic or shared graph from being
 * counted twice. Both the completed-detail cache and the pending-detail store
 * budget against it, so they must measure the same way to stay comparable.
 */
export function estimateRetainedBytes(value: unknown, seen = new WeakSet<object>()): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  if (typeof value === "number" || typeof value === "bigint") return 8;
  if (typeof value === "boolean") return 4;
  if (typeof value !== "object" || seen.has(value)) return 0;
  seen.add(value);

  if (Array.isArray(value)) {
    return 32 + value.reduce((total, entry) => total + estimateRetainedBytes(entry, seen), 0);
  }

  let bytes = 64;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    bytes += Buffer.byteLength(key, "utf8") + estimateRetainedBytes(entry, seen);
  }
  return bytes;
}
