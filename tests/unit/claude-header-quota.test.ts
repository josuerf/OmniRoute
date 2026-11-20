import test from "node:test";
import assert from "node:assert/strict";
import {
  parseClaudeUnifiedHeaders,
  recordClaudeHeaderQuota,
  getClaudeHeaderQuota,
  clearClaudeHeaderQuota,
  toQuotaWindows,
  isClaudeHeaderQuotaConnection,
  readStoredClaudeHeaderQuota,
} from "../../src/lib/quota/claudeHeaderQuota.ts";

const NOW = Date.parse("2026-11-20T12:00:00Z");
const reset5 = String(Math.floor(NOW / 1000) + 3600);
const reset7 = String(Math.floor(NOW / 1000) + 86400);
const hdrs = () =>
  new Headers({
    "anthropic-ratelimit-unified-5h-utilization": "0.25",
    "anthropic-ratelimit-unified-5h-reset": reset5,
    "anthropic-ratelimit-unified-5h-status": "allowed",
    "anthropic-ratelimit-unified-7d-utilization": "0.5",
    "anthropic-ratelimit-unified-7d-reset": reset7,
    "anthropic-ratelimit-unified-7d-status": "allowed_warning",
    "anthropic-ratelimit-unified-status": "allowed",
    authorization: "Bearer sk-ant-oat01-TESTE",
  });
const SETUP = { authMethod: "setup_token", scopes: ["user:inference"] };
const OAUTH = { scopes: ["user:inference", "user:profile"] };

test("parse: fraction -> percent, reset epoch -> ISO, null without window headers", () => {
  const r = parseClaudeUnifiedHeaders(hdrs(), NOW)!;
  assert.equal(r.fiveHour!.utilization, 25);
  assert.equal(r.sevenDay!.utilization, 50);
  assert.equal(r.fiveHour!.resetAt, new Date(Number(reset5) * 1000).toISOString());
  assert.equal(r.sevenDay!.status, "allowed_warning");
  assert.equal(r.status, "allowed");
  assert.equal(
    parseClaudeUnifiedHeaders({ "anthropic-ratelimit-unified-status": "allowed" }),
    null
  );
  assert.equal(parseClaudeUnifiedHeaders(null), null);
  const clamp = parseClaudeUnifiedHeaders({ "Anthropic-Ratelimit-Unified-5h-Utilization": "1.7" })!;
  assert.equal(clamp.fiveHour!.utilization, 100);
  assert.equal(JSON.stringify(r).includes("sk-ant"), false);
});

test("toQuotaWindows uses OAuth keys and drops stale/expired windows", () => {
  const r = parseClaudeUnifiedHeaders(hdrs(), NOW)!;
  const q = toQuotaWindows(r, NOW).quotas as any;
  assert.deepEqual(Object.keys(q).sort(), ["session (5h)", "weekly (7d)"]);
  assert.equal(q["session (5h)"].used, 25);
  assert.equal(q["session (5h)"].remainingPercentage, 75);
  assert.deepEqual(toQuotaWindows(r, NOW + 2 * 3600_000).quotas, {}); // stale (>1h)
  const after5h = toQuotaWindows({ ...r, observedAt: NOW + 3500_000 }, NOW + 3700_000)
    .quotas as any;
  assert.deepEqual(Object.keys(after5h), ["weekly (7d)"]); // 5h reset already passed
});

test("record: setup_token stores, feeds cache and persists with throttle", async () => {
  clearClaudeHeaderQuota();
  const persisted: any[] = [];
  const fed: any[] = [];
  const deps = {
    providerSpecificData: SETUP,
    persist: async (id: string, s: any) => void persisted.push([id, s]),
    feedCache: (id: string, q: any) => void fed.push([id, q]),
  };
  assert.ok(recordClaudeHeaderQuota("c1", hdrs(), NOW, deps));
  assert.equal(getClaudeHeaderQuota("c1")!.fiveHour!.utilization, 25);
  assert.equal(fed.length, 1);
  assert.equal(persisted.length, 1);
  assert.equal(typeof persisted[0][1].observedAt, "string");
  assert.equal(JSON.stringify(persisted[0][1]).includes("sk-ant"), false);
  // same values: no persist
  recordClaudeHeaderQuota("c1", hdrs(), NOW + 10_000, deps);
  assert.equal(persisted.length, 1);
  // changed within 1 min of last persist: throttled
  const h2 = hdrs();
  h2.set("anthropic-ratelimit-unified-5h-utilization", "0.30");
  recordClaudeHeaderQuota("c1", h2, NOW + 30_000, deps);
  assert.equal(persisted.length, 1);
  // changed after 1 min: persisted
  recordClaudeHeaderQuota("c1", h2, NOW + 200_000, deps);
  assert.equal(persisted.length, 2);
  const back = readStoredClaudeHeaderQuota({ lastRateLimit: persisted[1][1] })!;
  assert.equal(back.fiveHour!.utilization, 30);
  assert.equal(
    getClaudeHeaderQuota("zzz", { lastRateLimit: persisted[1][1] })!.fiveHour!.utilization,
    30
  );
});

test("regression: OAuth / no scopes / bad input are no-ops and never throw", () => {
  clearClaudeHeaderQuota();
  let calls = 0;
  const deps = { persist: async () => void calls++, feedCache: () => void calls++ };
  for (const psd of [OAUTH, {}, undefined, null, { scopes: "user:inference" }]) {
    assert.equal(
      recordClaudeHeaderQuota("o1", hdrs(), NOW, { ...deps, providerSpecificData: psd }),
      null
    );
  }
  assert.equal(
    recordClaudeHeaderQuota(null, hdrs(), NOW, { ...deps, providerSpecificData: SETUP }),
    null
  );
  assert.equal(
    recordClaudeHeaderQuota("o1", undefined, NOW, { ...deps, providerSpecificData: SETUP }),
    null
  );
  assert.equal(getClaudeHeaderQuota("o1"), null);
  assert.equal(calls, 0);
  assert.equal(isClaudeHeaderQuotaConnection(OAUTH), false);
  assert.equal(isClaudeHeaderQuotaConnection(SETUP), true);
  const boom = recordClaudeHeaderQuota("c9", hdrs(), NOW, {
    providerSpecificData: SETUP,
    persist: () => {
      throw new Error("x");
    },
    feedCache: () => {
      throw new Error("y");
    },
  });
  assert.equal(boom, null);
});

test("status headers that are long or have odd characters are dropped", () => {
  const r = parseClaudeUnifiedHeaders(
    {
      "anthropic-ratelimit-unified-5h-utilization": "0.1",
      "anthropic-ratelimit-unified-5h-status": "x".repeat(200),
      "anthropic-ratelimit-unified-status": "allowed<script>",
    },
    NOW
  )!;
  assert.equal(r.fiveHour!.status, null);
  assert.equal(r.status, undefined);
  const ok = parseClaudeUnifiedHeaders(
    {
      "anthropic-ratelimit-unified-5h-utilization": "0.1",
      "anthropic-ratelimit-unified-5h-status": " Allowed_Warning ",
    },
    NOW
  )!;
  assert.equal(ok.fiveHour!.status, "allowed_warning");
});
