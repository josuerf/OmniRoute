// IAF-491 — a fatia de fair-share da própria chave em GET /api/v1/me/status.
//
// Antes disso o rateio por chave só saía de GET /api/quota/pools/{id}/usage, atrás de
// requireManagementAuth: o dono de uma chave via o teto do pool (accountQuotas) mas não a
// própria parte, e só descobria que tinha estourado quando a requisição era recusada.
//
// Os quatro testes abaixo são os quatro critérios de aceite do card, incluindo o de
// privacidade: a resposta não pode revelar o consumo individual das outras chaves do pool.

import test from "node:test";
import assert from "node:assert/strict";

import {
  SELF_ACCOUNT_QUOTA_SCOPE,
  SELF_USAGE_SCOPE,
} from "../../src/shared/constants/selfServiceScopes.ts";
import { buildApiKeySelfServiceStatus } from "../../src/lib/usage/apiKeySelfService.ts";

const NOW = Date.UTC(2026, 8, 18, 12, 0, 0);

/** Deps base: sem pool, sem conexão, nenhuma chamada de rede. */
function makeBaseDeps(overrides: Record<string, unknown> = {}) {
  return {
    now: () => NOW,
    getCostSummary: () => ({
      budget: null,
      totalCostMonth: 5,
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
          inputTokens: 10,
          outputTokens: 2,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          reasoningTokens: 0,
        }),
      }),
    }),
    getProviderConnectionById: async () => null,
    getProviderConnections: async () => [],
    fetchAndPersistProviderLimits: async () => {
      throw new Error("unexpected quota fetch");
    },
    // Seams do rateio: sem allocation, o restante nunca é chamado.
    listAllocationsForApiKey: () => [],
    getPool: () => null,
    resolveConnectionProvider: async () => "claude",
    resolvePlan: () => ({ dimensions: [] }),
    getQuotaStore: async () => ({
      poolUsageWithDimensions: async () => {
        throw new Error("unexpected pool usage call");
      },
      poolUsage: async () => {
        throw new Error("unexpected pool usage call");
      },
    }),
    ...overrides,
  };
}

/**
 * Deps de uma chave dentro de um pool com duas contas: o plano declara 100% por conta e a
 * rota de management escala o limite pelo número de contas, então o teto efetivo é 200.
 * Três chaves dividem o pool; `key-self` é a que consulta.
 */
function makePooledDeps(overrides: Record<string, unknown> = {}) {
  return makeBaseDeps({
    listAllocationsForApiKey: (apiKeyId: string) => [
      {
        poolId: "pool-1",
        allocation: { apiKeyId, weight: 40, policy: "hard", capValue: 60, capUnit: "percent" },
      },
    ],
    getPool: (id: string) =>
      id === "pool-1"
        ? { id: "pool-1", connectionId: "conn-1", connectionIds: ["conn-1", "conn-2"] }
        : null,
    resolveConnectionProvider: async () => "claude",
    resolvePlan: () => ({
      dimensions: [
        { unit: "percent", window: "5h", limit: 100 },
        { unit: "percent", window: "7d", limit: 100 },
      ],
    }),
    getQuotaStore: async () => ({
      poolUsageWithDimensions: async (
        poolId: string,
        dims: Array<{ unit: string; window: string; limit: number }>
      ) => ({
        poolId,
        generatedAt: new Date(NOW).toISOString(),
        dimensions: dims.map((dim) => ({
          unit: dim.unit,
          window: dim.window,
          limit: dim.limit,
          consumedTotal: dim.window === "5h" ? 30 : 150,
          perKey: [
            {
              apiKeyId: "key-self",
              consumed: dim.window === "5h" ? 10 : 70,
              fairShare: dim.limit * 0.4,
              deficit: 0,
              borrowing: dim.window === "7d",
            },
            {
              apiKeyId: "key-outra-pessoa",
              consumed: dim.window === "5h" ? 20 : 80,
              fairShare: dim.limit * 0.3,
              deficit: 12,
              borrowing: false,
            },
          ],
        })),
      }),
      poolUsage: async () => {
        throw new Error("should use poolUsageWithDimensions when the plan has dimensions");
      },
    }),
    ...overrides,
  });
}

const pooledMetadata = {
  id: "key-self",
  name: "minha-chave",
  scopes: [SELF_USAGE_SCOPE, SELF_ACCOUNT_QUOTA_SCOPE],
  allowedConnections: [],
};

test("a chave em rateio recebe a própria fatia nas janelas de 5h e 7d", async () => {
  const status = await buildApiKeySelfServiceStatus(pooledMetadata, makePooledDeps());

  assert.ok(Array.isArray(status.poolQuotas), "poolQuotas deveria existir");
  assert.equal(status.poolQuotas.length, 1);

  const pool = status.poolQuotas[0];
  assert.equal(pool.poolId, "pool-1");
  assert.equal(pool.provider, "claude");
  assert.equal(pool.weight, 40);

  const byWindow = new Map(pool.dimensions.map((d: { window: string }) => [d.window, d]));

  // Limite escalado pelas 2 contas do pool (100 por conta), como a rota de management faz.
  const w5h = byWindow.get("5h");
  assert.equal(w5h.limit, 200);
  assert.equal(w5h.fairShare, 80);
  assert.equal(w5h.consumed, 10);
  assert.equal(w5h.remaining, 70);
  assert.equal(w5h.borrowing, false);

  const w7d = byWindow.get("7d");
  assert.equal(w7d.fairShare, 80);
  assert.equal(w7d.consumed, 70);
  assert.equal(w7d.remaining, 10);
  assert.equal(w7d.borrowing, true, "o modo generoso precisa ser visível para o dono da chave");

  // Cap absoluto personalizado da allocation, quando existe.
  assert.equal(pool.cap.value, 60);
  assert.equal(pool.cap.unit, "percent");

  // Um único pool também aparece na forma singular, como accountQuota já faz.
  assert.equal(status.poolQuota.poolId, "pool-1");
});

test("a chave fora de qualquer rateio responde sem a seção de rateio e sem erro", async () => {
  const status = await buildApiKeySelfServiceStatus(pooledMetadata, makeBaseDeps());

  assert.equal("poolQuotas" in status, false);
  assert.equal("poolQuota" in status, false);
  assert.equal(status.usage.cost.usedUsd, 5);
});

test("a resposta não revela o consumo individual das outras chaves do rateio", async () => {
  const status = await buildApiKeySelfServiceStatus(pooledMetadata, makePooledDeps());

  const serialized = JSON.stringify(status);
  assert.equal(
    serialized.includes("key-outra-pessoa"),
    false,
    "o id de outra chave do pool vazou na resposta"
  );
  assert.equal(serialized.includes("perKey"), false, "o array perKey inteiro vazou na resposta");

  // O agregado do pool pode aparecer: ele não identifica ninguém e é o que explica
  // por que a chave está ou não em modo generoso.
  const w5h = status.poolQuotas[0].dimensions.find((d: { window: string }) => d.window === "5h");
  assert.equal(w5h.consumedTotal, 30);
});

test("sem o scope self:account-quota a fatia do rateio não é devolvida", async () => {
  const status = await buildApiKeySelfServiceStatus(
    { ...pooledMetadata, scopes: [SELF_USAGE_SCOPE] },
    makePooledDeps({
      listAllocationsForApiKey: () => {
        throw new Error("não deve consultar o rateio sem o scope");
      },
    })
  );

  assert.equal("poolQuotas" in status, false);
  assert.equal("poolQuota" in status, false);
});
