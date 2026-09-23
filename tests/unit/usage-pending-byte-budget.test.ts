import test from "node:test";
import assert from "node:assert/strict";

const {
  trackPendingRequest,
  finalizePendingRequestById,
  getPendingById,
  getPendingRequests,
  getPendingDetailsByteSize,
  sweepStalePendingRequests,
  clearPendingRequests,
  MAX_PENDING_DETAILS_BYTES,
} = await import("../../src/lib/usage/usageHistory.ts");

const HOUR_MS = 60 * 60 * 1000;

/**
 * IAF-492: `pendingById` is an index, not the store. The store is
 * `pendingRequests.details[connectionId][modelKey]`. Two attempts of one client
 * request share a correlationId, so the second reuses the first's id and
 * overwrites the id-keyed view — but it is pushed into its OWN bucket. The
 * first detail is then unreachable from `pendingById`, which is exactly what
 * the age sweep and the 5000-entry cap iterate, so it is retained forever.
 *
 * Since upstream #14319 the age pass MARKS over-age details instead of removing
 * them, so a stuck request stays visible on the dashboard. That makes reaching
 * the orphan matter more, not less: an entry the sweep cannot see is neither
 * marked nor ever reclaimed by the byte budget.
 */
test("sweep reaches bucket details the id index no longer points at", () => {
  clearPendingRequests();

  const firstId = trackPendingRequest("model-a", "prov-a", "conn", true, {
    correlationId: "shared-correlation",
  });
  const secondId = trackPendingRequest("model-b", "prov-b", "conn", true, {
    correlationId: "shared-correlation",
  });

  // Same client request, so the second attempt deliberately reuses the id.
  assert.equal(secondId, firstId, "both attempts should share one pending id");
  assert.equal(getPendingById().size, 1, "the id index only keeps the newest attempt");
  assert.equal(getPendingRequests().byModel["model-a (prov-a)"], 1);
  assert.equal(getPendingRequests().byModel["model-b (prov-b)"], 1);

  // Age every detail past the sweep window, reaching them through the store
  // rather than the index — the orphan is not in the index by construction.
  const buckets = getPendingRequests().details["conn"];
  for (const bucket of Object.values(buckets)) {
    for (const detail of bucket) detail.startedAt = Date.now() - 2 * HOUR_MS;
  }

  assert.equal(
    sweepStalePendingRequests(Date.now(), HOUR_MS),
    0,
    "over-age details are marked, not removed"
  );
  const aged = Object.values(getPendingRequests().details["conn"]).flat();
  assert.equal(aged.length, 2, "marking must keep both details in the store");
  assert.ok(
    aged.every((detail) => detail.stale === true),
    "both the indexed detail and the orphan must be marked"
  );

  // Reclaim is the byte budget's job now, and it has to reach the orphan too.
  const removed = sweepStalePendingRequests(Date.now(), HOUR_MS, 1);

  assert.equal(removed, 2, "both the indexed detail and the orphan must be reclaimed");
  assert.equal(
    getPendingRequests().byModel["model-a (prov-a)"],
    undefined,
    "the orphan's counter must self-heal instead of drifting up forever"
  );
  assert.equal(getPendingRequests().byModel["model-b (prov-b)"], undefined);
  assert.equal(getPendingRequests().details["conn"], undefined, "empty buckets must be dropped");
  assert.equal(getPendingDetailsByteSize(), 0);

  clearPendingRequests();
});

test("reclaiming an orphan never evicts the live detail sharing its id", () => {
  clearPendingRequests();

  // The orphan carries a payload preview and the live attempt does not, so a
  // budget of half the store reclaims the orphan alone: eviction walks
  // oldest-first (the orphan) and stops as soon as the store fits.
  const sharedId = trackPendingRequest("model-a", "prov-a", "conn", true, {
    correlationId: "shared-correlation",
    clientRequest: { note: "x".repeat(4000) },
  });
  trackPendingRequest("model-b", "prov-b", "conn", true, { correlationId: "shared-correlation" });

  // Only the orphan is over-age; the newest attempt is still in flight.
  const orphan = getPendingRequests().details["conn"]["model-a (prov-a)"][0];
  orphan.startedAt = Date.now() - 2 * HOUR_MS;

  assert.equal(sweepStalePendingRequests(Date.now(), HOUR_MS), 0);
  assert.equal(orphan.stale, true, "the orphan must be marked even though the index misses it");
  assert.notEqual(
    getPendingRequests().details["conn"]["model-b (prov-b)"][0].stale,
    true,
    "the in-flight attempt must not be marked"
  );

  const budget = Math.floor(getPendingDetailsByteSize() / 2);
  const removed = sweepStalePendingRequests(Date.now(), HOUR_MS, budget);

  assert.equal(removed, 1, "only the marked orphan should be reclaimed");
  assert.ok(
    getPendingById().has(sharedId!),
    "the live attempt must survive — it merely shares the orphan's id"
  );
  assert.equal(getPendingRequests().details["conn"]["model-b (prov-b)"].length, 1);
  assert.equal(getPendingRequests().details["conn"]["model-a (prov-a)"], undefined);

  clearPendingRequests();
});

test("sweep enforces a byte budget by dropping the oldest details first", () => {
  clearPendingRequests();

  const payload = { note: "x".repeat(1000) };
  const startedAtBase = Date.now() - 1_000;
  const ids: string[] = [];
  for (let index = 0; index < 6; index += 1) {
    const id = trackPendingRequest(`model-${index}`, "prov", "conn", true, {
      clientRequest: payload,
      providerRequest: payload,
    });
    assert.ok(id, "each tracked request should produce an id");
    ids.push(id!);
    // Distinct, increasing ages — recent enough that the age sweep ignores
    // them, so only the byte budget can evict here.
    getPendingById().get(id!)!.startedAt = startedAtBase + index;
  }

  const beforeBytes = getPendingDetailsByteSize();
  assert.ok(beforeBytes > 6 * 2000, `payload should dominate the estimate, got ${beforeBytes}`);

  // Budget deliberately smaller than the live set: nothing is stale by age and
  // the 5000-entry cap is untouched, so only the byte budget can evict here.
  const budgetBytes = Math.floor(beforeBytes / 2);
  const removed = sweepStalePendingRequests(Date.now(), HOUR_MS, budgetBytes);

  assert.ok(removed > 0, "the byte budget must evict the overflow");
  assert.ok(
    getPendingDetailsByteSize() <= budgetBytes,
    `expected <= ${budgetBytes} bytes, got ${getPendingDetailsByteSize()}`
  );
  assert.equal(getPendingById().has(ids[0]), false, "the oldest detail goes first");
  assert.ok(getPendingById().has(ids[5]), "the newest detail must survive");

  clearPendingRequests();
});

test("the byte budget leaves a normal in-flight set untouched", () => {
  clearPendingRequests();

  const id = trackPendingRequest("model", "prov", "conn", true, {
    clientRequest: { note: "small" },
  });
  assert.ok(id);

  const removed = sweepStalePendingRequests(Date.now(), HOUR_MS);

  assert.equal(removed, 0, "a single small in-flight request is nowhere near the budget");
  assert.ok(getPendingById().has(id!));
  assert.ok(
    getPendingDetailsByteSize() < MAX_PENDING_DETAILS_BYTES,
    "the default budget must have real headroom for live traffic"
  );

  assert.equal(finalizePendingRequestById(id!, { status: 200 }), true);
  assert.equal(getPendingDetailsByteSize(), 0, "finalized details leave no accounted bytes");

  clearPendingRequests();
});
