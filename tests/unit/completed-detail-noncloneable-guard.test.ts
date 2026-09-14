import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { useDecollidedMigrationsDir } from "./helpers/decollidedMigrationsDir.ts";

useDecollidedMigrationsDir();
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-detach-guard-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const {
  storeCompletedDetail,
  getCompletedDetails,
  getCompletedDetailsCacheStats,
  clearCompletedDetails,
} = await import("../../src/lib/usage/completedRequestDetails.ts");

type Detail = Parameters<typeof storeCompletedDetail>[0];

function baseDetail(id: string, extra: Record<string, unknown> = {}): Detail {
  return {
    id,
    model: "claude/claude-sonnet-5",
    provider: "claude",
    connectionId: "conn-1",
    startedAt: Date.now(),
    ...extra,
  } as Detail;
}

test("storeCompletedDetail detaches a normal completed detail", () => {
  clearCompletedDetails();

  const stored = storeCompletedDetail(baseDetail("plain", { clientRequest: { text: "hello" } }));

  assert.equal(stored, true);
  assert.equal(getCompletedDetails().has("plain"), true);
  // The cached entry must be the cache's own copy, never the caller's object graph.
  assert.notEqual(getCompletedDetails().get("plain")?.clientRequest, undefined);
});

test("a non-cloneable payload never breaks request finalization", () => {
  clearCompletedDetails();
  const before = getCompletedDetailsCacheStats();

  // structuredClone throws DataCloneError on a function. truncatePendingPreview() passes
  // non-object values straight through, so one can reach the cache from a real payload.
  const detail = baseDetail("non-cloneable", { clientRequest: { onToken: () => "boom" } });

  let stored: boolean | undefined;
  assert.doesNotThrow(() => {
    stored = storeCompletedDetail(detail);
  });

  assert.equal(stored, false, "the entry must be reported as not cached");
  assert.equal(getCompletedDetails().has("non-cloneable"), false, "nothing may be cached");

  const after = getCompletedDetailsCacheStats();
  assert.equal(after.entries, before.entries, "entry count must not drift");
  assert.equal(after.bytes, before.bytes, "byte accounting must not drift");
  assert.equal(after.cleanupTimers, before.cleanupTimers, "no cleanup timer may leak");
});

test("a failed detach leaves no stale entry behind for the same id", () => {
  clearCompletedDetails();

  assert.equal(storeCompletedDetail(baseDetail("reused", { clientRequest: { a: 1 } })), true);
  assert.equal(getCompletedDetails().has("reused"), true);

  // A later completion for the same id that cannot be cloned must evict the earlier copy
  // rather than leave a stale preview the dashboard would keep showing.
  const stored = storeCompletedDetail(baseDetail("reused", { clientRequest: { fn: () => 1 } }));

  assert.equal(stored, false);
  assert.equal(getCompletedDetails().has("reused"), false);
  assert.equal(getCompletedDetailsCacheStats().bytes, 0);
});

test.after(() => {
  clearCompletedDetails();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});
