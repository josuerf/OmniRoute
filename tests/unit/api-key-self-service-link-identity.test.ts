import test from "node:test";
import assert from "node:assert/strict";

import {
  SELF_ACCOUNT_QUOTA_SCOPE,
  SELF_USAGE_SCOPE,
} from "../../src/shared/constants/selfServiceScopes.ts";
import { clearClaudeHeaderQuota } from "../../src/lib/quota/claudeHeaderQuota.ts";
import { buildApiKeySelfServiceStatus } from "../../src/lib/usage/apiKeySelfService.ts";

type Row = Record<string, unknown>;

const NOW = Date.UTC(2026, 4, 29, 12, 0, 0);
const LINKED = "2026-05-01T10:00:00.000Z";

function makeDeps(rows: Record<string, Row>) {
  return {
    now: () => NOW,
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
    fetchAndPersistProviderLimits: async (id: string) => ({
      connection: { id },
      usage: { message: "skipped" },
      cache: {},
    }),
  };
}

const metadata = (id: string, ids: string[]) => ({
  id,
  name: "k",
  scopes: [SELF_USAGE_SCOPE, SELF_ACCOUNT_QUOTA_SCOPE],
  allowedConnections: ids,
});

const setupRow = (id: string, ownerKeyId: string, extra: Row = {}): Row => ({
  id,
  provider: "claude",
  isActive: true,
  providerSpecificData: {
    authMethod: "setup_token",
    scopes: ["user:inference"],
    ownerKeyId,
    linkedAt: LINKED,
  },
  ...extra,
});

async function quotas(keyId: string, ids: string[], rows: Record<string, Row>) {
  clearClaudeHeaderQuota();
  const status = await buildApiKeySelfServiceStatus(metadata(keyId, ids) as never, {
    ...(makeDeps(rows) as never),
  });
  return (status as { accountQuotas: Array<Record<string, unknown>> }).accountQuotas;
}

test("owner sees authMethod and linkedAt on own setup_token connection", async () => {
  const [q] = await quotas("key-A", ["c-a"], { "c-a": setupRow("c-a", "key-A") });
  assert.equal(q.authMethod, "setup_token");
  assert.equal(q.linkedAt, LINKED);
  assert.equal(q.available, false);
});

test("key A never sees authMethod/linkedAt of a connection owned by key B (shared)", async () => {
  const rows = {
    "c-a": setupRow("c-a", "key-A"),
    "c-b": setupRow("c-b", "key-B"),
  };
  const list = await quotas("key-A", ["c-a", "c-b"], rows);
  const own = list.find((x) => x.connectionId === "c-a")!;
  const other = list.find((x) => x.connectionId === "c-b")!;
  assert.equal(own.authMethod, "setup_token");
  assert.equal(own.linkedAt, LINKED);
  assert.equal("authMethod" in other, false);
  assert.equal("linkedAt" in other, false);
  const dump = JSON.stringify(list);
  assert.equal(dump.includes("key-B"), false);
  assert.equal(dump.includes("ownerKeyId"), false);
});

test("revoked own connection still carries authMethod and linkedAt", async () => {
  const rows = {
    "c-a": setupRow("c-a", "key-A", { isActive: false, lastErrorType: "token_revoked" }),
  };
  const [q] = await quotas("key-A", ["c-a"], rows);
  assert.equal(q.reason, "token_revoked");
  assert.equal(q.authMethod, "setup_token");
  assert.equal(q.linkedAt, LINKED);
});

test("OAuth claude connection never carries authMethod/linkedAt", async () => {
  const rows = {
    "c-o": {
      id: "c-o",
      provider: "claude",
      isActive: true,
      providerSpecificData: {
        scopes: ["user:inference", "user:profile"],
        ownerKeyId: "key-A",
        linkedAt: LINKED,
      },
    },
  };
  const [q] = await quotas("key-A", ["c-o"], rows);
  assert.equal("authMethod" in q, false);
  assert.equal("linkedAt" in q, false);
});

test("invalid linkedAt is omitted but authMethod stays", async () => {
  const row = setupRow("c-a", "key-A");
  (row.providerSpecificData as Row).linkedAt = "not-a-date";
  const [q] = await quotas("key-A", ["c-a"], { "c-a": row });
  assert.equal(q.authMethod, "setup_token");
  assert.equal("linkedAt" in q, false);
});
