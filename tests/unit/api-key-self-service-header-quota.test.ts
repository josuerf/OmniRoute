import test from "node:test";
import assert from "node:assert/strict";

import {
  SELF_ACCOUNT_QUOTA_SCOPE,
  SELF_USAGE_SCOPE,
} from "../../src/shared/constants/selfServiceScopes.ts";
import {
  recordClaudeHeaderQuota,
  clearClaudeHeaderQuota,
} from "../../src/lib/quota/claudeHeaderQuota.ts";
import { buildApiKeySelfServiceStatus } from "../../src/lib/usage/apiKeySelfService.ts";

type Row = Record<string, unknown>;

function makeDeps(rows: Record<string, Row>, fetched: string[]) {
  return {
    now: () => Date.UTC(2026, 4, 29, 12, 0, 0),
    getCostSummary: () => ({
      budget: null,
      totalCostMonth: 0,
      totalCostPeriod: 0,
      activeLimitUsd: 0,
      resetInterval: null,
      resetTime: null,
      budgetResetAt: null,
      lastBudgetResetAt: null,
      periodStartAt: null,
      nextResetAt: null,
      warningThreshold: null,
    }),
    checkBudget: () => ({ allowed: true }),
    getDbInstance: () => ({
      prepare: () => ({
        get: () => ({
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          reasoningTokens: 0,
        }),
      }),
    }),
    getProviderConnectionById: async (id: string) => rows[id] ?? null,
    getProviderConnections: async () => [],
    fetchAndPersistProviderLimits: async (id: string) => {
      fetched.push(id);
      // setup-token usage is skipped upstream: message only, no quotas/plan.
      return { connection: { id }, usage: { message: "skipped" }, cache: {} };
    },
  };
}

const metadata = (ids: string[]) => ({
  id: "key-1",
  name: "k",
  scopes: [SELF_USAGE_SCOPE, SELF_ACCOUNT_QUOTA_SCOPE],
  allowedConnections: ids,
});

const setupData = { authMethod: "setup_token", scopes: ["user:inference"] };
const NOW = Date.UTC(2026, 4, 29, 12, 0, 0);

function seed(id: string, utilization: string, observedAt = Date.now()) {
  recordClaudeHeaderQuota(
    id,
    new Headers({
      "anthropic-ratelimit-unified-5h-utilization": utilization,
      "anthropic-ratelimit-unified-5h-reset": String(Math.floor(observedAt / 1000) + 3600),
      "anthropic-ratelimit-unified-7d-utilization": "0.1",
      "anthropic-ratelimit-unified-7d-reset": String(Math.floor(observedAt / 1000) + 86400),
    }),
    observedAt,
    { providerSpecificData: setupData, feedCache: () => {}, persist: async () => {} }
  );
}

const byId = (s: any) => Object.fromEntries(s.accountQuotas.map((q: any) => [q.connectionId, q]));

test("setup_token with stored header reading returns quotas from response_headers", async () => {
  clearClaudeHeaderQuota();
  seed("c-st", "0.25");
  const fetched: string[] = [];
  const deps = {
    ...makeDeps(
      {
        "c-st": {
          id: "c-st",
          provider: "claude",
          isActive: true,
          testStatus: "active",
          providerSpecificData: setupData,
        },
      },
      fetched
    ),
    now: () => Date.now(),
  };
  const q = byId(await buildApiKeySelfServiceStatus(metadata(["c-st"]), deps))["c-st"];
  assert.equal(q.available, true);
  assert.equal(q.quotaSource, "response_headers");
  assert.ok(!Number.isNaN(Date.parse(q.observedAt)));
  assert.deepEqual(Object.keys(q.quotas).sort(), ["session (5h)", "weekly (7d)"]);
  assert.equal(q.quotas["session (5h)"].usedPercentage, 25);
  assert.equal(q.quotas["session (5h)"].remainingPercentage, 75);
  assert.ok(typeof q.quotas["session (5h)"].resetAt === "string");
  const json = JSON.stringify(q);
  assert.ok(!/scopes|accessToken|ownerKeyId|user:inference/.test(json));
  assert.deepEqual(fetched, []);
});

test("setup_token without (or with stale) reading stays not_available; revoked wins", async () => {
  clearClaudeHeaderQuota();
  seed("c-stale", "0.5", Date.now() - 2 * 3600_000);
  seed("c-rev", "0.5");
  const mk = (id: string, extra = {}) => ({
    id,
    provider: "claude",
    isActive: true,
    testStatus: "active",
    providerSpecificData: setupData,
    ...extra,
  });
  const deps = makeDeps(
    {
      "c-none": mk("c-none"),
      "c-stale": mk("c-stale"),
      "c-rev": mk("c-rev", { testStatus: "expired", lastErrorType: "token_revoked" }),
    },
    []
  );
  const r = byId(
    await buildApiKeySelfServiceStatus(metadata(["c-none", "c-stale", "c-rev"]), deps)
  );
  assert.equal(r["c-none"].reason, "not_available");
  assert.equal(r["c-stale"].reason, "not_available");
  assert.equal(r["c-rev"].reason, "token_revoked");
});

test("regression: OAuth connection (user:profile) keeps using the usage fetch, ignoring header store", async () => {
  clearClaudeHeaderQuota();
  const oauth = { scopes: ["user:inference", "user:profile"] };
  recordClaudeHeaderQuota(
    "c-oa",
    new Headers({ "anthropic-ratelimit-unified-5h-utilization": "0.9" }),
    Date.now(),
    { providerSpecificData: oauth }
  );
  const fetched: string[] = [];
  const deps = makeDeps(
    {
      "c-oa": {
        id: "c-oa",
        provider: "claude",
        isActive: true,
        testStatus: "active",
        providerSpecificData: oauth,
      },
    },
    fetched
  );
  const q = byId(await buildApiKeySelfServiceStatus(metadata(["c-oa"]), deps))["c-oa"];
  assert.deepEqual(fetched, ["c-oa"]);
  assert.equal(q.reason, "not_available");
  assert.equal(q.quotaSource, undefined);
  assert.equal(NOW > 0, true);
});
