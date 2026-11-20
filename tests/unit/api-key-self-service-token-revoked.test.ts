import test from "node:test";
import assert from "node:assert/strict";

import {
  SELF_ACCOUNT_QUOTA_SCOPE,
  SELF_USAGE_SCOPE,
} from "../../src/shared/constants/selfServiceScopes.ts";
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

test("M3: revoked setup-token (expired/token_revoked) reports reason token_revoked, not not_available", async () => {
  const fetched: string[] = [];
  const deps = makeDeps(
    {
      "c-revoked": {
        id: "c-revoked",
        provider: "claude",
        isActive: true,
        testStatus: "expired",
        lastErrorType: "token_revoked",
        providerSpecificData: setupData,
      },
      "c-ok": {
        id: "c-ok",
        provider: "claude",
        isActive: true,
        testStatus: "active",
        providerSpecificData: setupData,
      },
    },
    fetched
  );
  const status = await buildApiKeySelfServiceStatus(metadata(["c-revoked", "c-ok"]), deps);
  const byId = Object.fromEntries(
    (status.accountQuotas as Array<{ connectionId: string }>).map((q) => [q.connectionId, q])
  );
  assert.equal(byId["c-revoked"].available, false);
  assert.equal(byId["c-revoked"].reason, "token_revoked");
  assert.equal(byId["c-ok"].reason, "not_available", "healthy setup-token keeps not_available");
  assert.ok(!fetched.includes("c-revoked"), "no pointless usage fetch for a revoked token");
});

test("M3: inactive claude connection parked by revocation still reports token_revoked", async () => {
  const deps = makeDeps(
    {
      "c-off": {
        id: "c-off",
        provider: "claude",
        isActive: false,
        testStatus: "expired",
        lastErrorType: "token_revoked",
        providerSpecificData: setupData,
      },
    },
    []
  );
  const status = await buildApiKeySelfServiceStatus(metadata(["c-off"]), deps);
  assert.equal(status.accountQuotas[0].connectionId, "c-off");
  assert.equal(status.accountQuotas[0].reason, "token_revoked");
});

test("M3: inactive connection without revocation stays hidden", async () => {
  const deps = makeDeps(
    {
      "c-off": { id: "c-off", provider: "claude", isActive: false, testStatus: "active" },
    },
    []
  );
  const status = await buildApiKeySelfServiceStatus(metadata(["c-off"]), deps);
  assert.equal(status.accountQuotas.length, 0);
});
