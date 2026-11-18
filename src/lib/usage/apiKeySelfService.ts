import type { ApiKeyUsageSlice } from "@/lib/db/apiKeyUsageSlices";
import { hasSelfAccountQuotaScope, hasSelfUsageScope } from "@/shared/constants/selfServiceScopes";

import {
  defaultQuotaRefreshTracker,
  listReachableProviders,
  resolveAccountQuotaEntries,
  type AccountQuotaDeps,
  type ProviderLimitsCacheLike,
  type ProviderLimitsFetchResultLike,
  type QuotaRefreshTracker,
} from "./apiKeySelfServiceAccounts";
import {
  buildSelfServiceLimits,
  buildUsageWindowSummary,
  getUtcDayWindow,
  getUtcIsoWeekWindow,
  type KeyQuotaStatusLike,
  type SelfServiceLimitDeps,
  type SelfServiceLimitMetadata,
  type TokenLimitLike,
  type UsageLimitStatusLike,
} from "./apiKeySelfServiceLimits";
import {
  collectLongContextCuts,
  defaultListPriceCache,
  summarizeListPrice,
  type ListPriceCache,
  type PriceTokensFn,
} from "./apiKeySelfServiceListPrice";
import {
  isoOrNull,
  roundNumber,
  toNumber,
  type DateLike,
  type JsonRecord,
} from "./apiKeySelfServiceShared";

export interface ApiKeySelfServiceMetadata {
  id: string;
  name: string;
  scopes: string[];
  allowedConnections: string[];
  usageLimitEnabled?: boolean;
  dailyUsageLimitUsd?: number | null;
  weeklyUsageLimitUsd?: number | null;
  /** From the key's self-service settings. null/undefined = all providers; [] = none. */
  sharedQuotaProviders?: string[] | null;
}

export interface ApiKeySelfServiceOptions {
  /**
   * Admin preview (GET /api/keys/[id]/self-service): skip the self:usage scope
   * check and always include accountQuotas (still filtered by the settings).
   */
  adminPreview?: boolean;
}

interface StatementLike {
  get: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
}

interface DbLike {
  prepare: (sql: string) => StatementLike;
}

interface CostSummaryLike {
  budget: unknown;
  totalCostMonth: number;
  totalCostPeriod: number;
  activeLimitUsd: number;
  resetInterval: string | null;
  budgetResetAt: DateLike;
  periodStartAt: DateLike;
  nextResetAt: DateLike;
  warningThreshold: number | null;
}

type GetCostSummaryFn = (apiKeyId: string) => CostSummaryLike;
type CheckBudgetFn = (apiKeyId: string) => unknown;
type GetDbInstanceFn = () => DbLike;
type GetProviderConnectionByIdFn = (connectionId: string) => Promise<unknown>;
type GetProviderConnectionsFn = (filters?: Record<string, unknown>) => Promise<unknown[]>;
type FetchAndPersistProviderLimitsFn = (
  connectionId: string,
  source: "manual" | "scheduled"
) => Promise<ProviderLimitsFetchResultLike>;

/**
 * Fatia do rateio (quota sharing) de UMA chave num pool. É o recorte próprio do
 * `PoolUsageSnapshot`: o agregado do pool mais a linha `perKey` do próprio chamador.
 * O `perKey` das demais chaves nunca sai daqui (IAF-491).
 */
interface PoolQuotaDimension {
  unit: string;
  window: string;
  /** Teto do pool na janela, já escalado pelo número de contas-membro. */
  limit: number;
  /** Consumo somado de todas as chaves do pool. Não identifica ninguém. */
  consumedTotal: number;
  /** A parte desta chave: limit × (weight / 100). */
  fairShare: number;
  consumed: number;
  /** `fairShare - consumed`, piso em 0. */
  remaining: number;
  deficit: number;
  /**
   * `true` quando a chave passou da própria fatia porque o pool está abaixo do
   * limiar de saturação (modo generoso do fair share). Nesse estado a fatia não
   * é um teto firme, e é isso que o dono da chave precisa saber.
   */
  borrowing: boolean;
}

interface PoolQuotaStatus {
  poolId: string;
  connectionId?: string;
  provider?: string;
  /** Peso da allocation desta chave, em porcentagem. */
  weight?: number;
  policy?: string;
  /** Cap absoluto personalizado da allocation, quando configurado. */
  cap?: { value: number; unit?: string };
  dimensions: PoolQuotaDimension[];
}

interface PoolAllocationLike {
  apiKeyId: string;
  weight?: number;
  policy?: string;
  capValue?: number;
  capUnit?: string;
}

interface PoolLike {
  id: string;
  connectionId?: string;
  connectionIds?: string[];
}

interface PoolUsageStoreLike {
  poolUsageWithDimensions: (
    poolId: string,
    planDimensions: Array<{ unit: string; window: string; limit: number }>
  ) => Promise<unknown>;
}

type ListAllocationsForApiKeyFn = (
  apiKeyId: string
) => Array<{ poolId: string; allocation: PoolAllocationLike }>;
type GetPoolFn = (poolId: string) => PoolLike | null;
type ResolveConnectionProviderFn = (connectionId: string) => Promise<string>;
type ResolvePlanFn = (
  connectionId: string,
  provider: string
) => { dimensions: Array<{ unit: string; window: string; limit: number }> };
type GetQuotaStoreFn = () => Promise<PoolUsageStoreLike>;

export interface ApiKeySelfServiceDeps {
  now?: () => number;
  getCostSummary?: GetCostSummaryFn;
  checkBudget?: CheckBudgetFn;
  getDbInstance?: GetDbInstanceFn;
  getProviderConnectionById?: GetProviderConnectionByIdFn;
  getProviderConnections?: GetProviderConnectionsFn;
  fetchAndPersistProviderLimits?: FetchAndPersistProviderLimitsFn;
  getProviderLimitsCache?: (connectionId: string) => ProviderLimitsCacheLike | null;
  quotaRefreshTracker?: QuotaRefreshTracker;
  getBudgetWindowTotal?: (apiKeyId: string, periodStartAt: number) => number;
  getApiKeyUsageLimitStatus?: (metadata: SelfServiceLimitMetadata) => Promise<UsageLimitStatusLike>;
  listTokenLimits?: (apiKeyId: string) => TokenLimitLike[];
  getWindowUsage?: (limit: TokenLimitLike, now: number) => number;
  resetWindowIfElapsed?: (
    limit: TokenLimitLike,
    now: number
  ) => { periodStartAt: number; nextResetAt: number };
  getKeyQuotaStatus?: (apiKeyId: string, deps: { now: () => number }) => KeyQuotaStatusLike;
  listApiKeyUsageSlices?: (
    db: DbLike,
    apiKeyId: string,
    windowStarts: string[],
    promptBandCuts: number[]
  ) => ApiKeyUsageSlice[];
  calculateCostDetailed?: PriceTokensFn;
  /** The merged pricing table (provider -> model -> row), read for long-context thresholds. */
  getPricingTable?: () => Promise<unknown>;
  /** Per-key list-price summaries, reused for 60 s. */
  listPriceCache?: ListPriceCache;
  listAllocationsForApiKey?: ListAllocationsForApiKeyFn;
  getPool?: GetPoolFn;
  resolveConnectionProvider?: ResolveConnectionProviderFn;
  resolvePlan?: ResolvePlanFn;
  getQuotaStore?: GetQuotaStoreFn;
}

interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

function withDateFallback(value: DateLike, fallback: number): DateLike {
  return isoOrNull(value) === null ? fallback : value;
}

function getCurrentMonthWindow(now: number) {
  const date = new Date(now);
  const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0, 0);
  const next = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1, 0, 0, 0, 0);
  return { periodStartAt: start, resetAt: next };
}

function buildCostStatus(summary: CostSummaryLike, now: number) {
  const hasBudget = !!summary.budget && toNumber(summary.activeLimitUsd) > 0;
  const fallbackWindow = getCurrentMonthWindow(now);
  const periodStartAt = hasBudget
    ? withDateFallback(summary.periodStartAt, fallbackWindow.periodStartAt)
    : fallbackWindow.periodStartAt;
  const resetAt = hasBudget
    ? withDateFallback(summary.nextResetAt ?? summary.budgetResetAt, fallbackWindow.resetAt)
    : fallbackWindow.resetAt;
  const usedUsd = hasBudget
    ? roundNumber(toNumber(summary.totalCostPeriod))
    : roundNumber(toNumber(summary.totalCostMonth));
  const limitUsd = hasBudget ? roundNumber(toNumber(summary.activeLimitUsd)) : null;
  const remainingUsd = limitUsd === null ? null : roundNumber(Math.max(limitUsd - usedUsd, 0));
  const usedPercent =
    limitUsd === null || limitUsd <= 0 ? null : roundNumber((usedUsd / limitUsd) * 100, 2);

  return {
    period: (hasBudget ? summary.resetInterval : "monthly") ?? "monthly",
    currency: "USD",
    usedUsd,
    limitUsd,
    remainingUsd,
    usedPercent,
    warningThreshold: hasBudget ? (summary.warningThreshold ?? null) : null,
    resetAt: isoOrNull(resetAt),
    periodStartAt: isoOrNull(periodStartAt),
  };
}

function aggregateTokens(db: DbLike, apiKeyId: string, periodStartAt: string): TokenTotals {
  const row = db
    .prepare(
      `
      SELECT
        COALESCE(SUM(tokens_input), 0) AS inputTokens,
        COALESCE(SUM(tokens_output), 0) AS outputTokens,
        COALESCE(SUM(tokens_cache_read), 0) AS cacheReadTokens,
        COALESCE(SUM(tokens_cache_creation), 0) AS cacheCreationTokens,
        COALESCE(SUM(tokens_reasoning), 0) AS reasoningTokens
      FROM usage_history
      WHERE api_key_id = ?
        AND timestamp >= ?
    `
    )
    .get(apiKeyId, periodStartAt) as JsonRecord | undefined;

  const inputTokens = toNumber(row?.inputTokens);
  const outputTokens = toNumber(row?.outputTokens);
  const cacheReadTokens = toNumber(row?.cacheReadTokens);
  const cacheCreationTokens = toNumber(row?.cacheCreationTokens);
  const reasoningTokens = toNumber(row?.reasoningTokens);

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    reasoningTokens,
    totalTokens:
      inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens + reasoningTokens,
  };
}

type RequiredDeps = Required<ApiKeySelfServiceDeps>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Recorta do `PoolUsageSnapshot` apenas o que pertence a esta chave, mais o agregado do
 * pool. A linha `perKey` das outras chaves fica de fora por construção: nada aqui copia o
 * array, só a entrada cujo `apiKeyId` é o do chamador (IAF-491).
 */
function toPoolQuotaDimensions(snapshot: unknown, apiKeyId: string): PoolQuotaDimension[] {
  const dimensions =
    isRecord(snapshot) && Array.isArray(snapshot.dimensions) ? snapshot.dimensions : [];

  const result: PoolQuotaDimension[] = [];
  for (const raw of dimensions) {
    if (!isRecord(raw)) continue;
    const perKey = Array.isArray(raw.perKey) ? raw.perKey : [];
    const mine = perKey.find((entry) => isRecord(entry) && entry.apiKeyId === apiKeyId);
    if (!isRecord(mine)) continue;

    const fairShare = toNumber(mine.fairShare);
    const consumed = toNumber(mine.consumed);
    result.push({
      unit: typeof raw.unit === "string" ? raw.unit : "",
      window: typeof raw.window === "string" ? raw.window : "",
      limit: toNumber(raw.limit),
      consumedTotal: toNumber(raw.consumedTotal),
      fairShare: roundNumber(fairShare),
      consumed: roundNumber(consumed),
      remaining: roundNumber(Math.max(0, fairShare - consumed)),
      deficit: roundNumber(toNumber(mine.deficit)),
      borrowing: mine.borrowing === true,
    });
  }
  return result;
}

/**
 * A fatia de rateio da própria chave, em cada pool de que ela participa.
 *
 * Fica atrás do mesmo scope de `accountQuotas` (`self:account-quota`): é o complemento
 * dele, o teto da conta compartilhada mais a parte que cabe a esta chave. Uma chave fora
 * de qualquer pool devolve `undefined`, e a seção some da resposta em vez de virar lista
 * vazia, para que "não participa de rateio" não se confunda com "rateio sem dados".
 *
 * Falha de um pool não derruba a consulta inteira: o pool problemático é omitido e os
 * demais respondem. O status de uso é uma tela de leitura, e meia resposta é melhor que
 * um 500.
 */
async function resolvePoolQuotas(
  metadata: ApiKeySelfServiceMetadata,
  deps: RequiredDeps
): Promise<PoolQuotaStatus[] | undefined> {
  if (!hasSelfAccountQuotaScope(metadata.scopes)) return undefined;

  let allocations: Array<{ poolId: string; allocation: PoolAllocationLike }>;
  try {
    allocations = deps.listAllocationsForApiKey(metadata.id) ?? [];
  } catch {
    return undefined;
  }
  if (!allocations.length) return undefined;

  const store = await deps.getQuotaStore();
  const resolved = await Promise.all(
    allocations.map(async ({ poolId, allocation }) => {
      try {
        const pool = deps.getPool(poolId);
        if (!pool) return null;

        const connectionId = pool.connectionId ?? pool.connectionIds?.[0];
        if (!connectionId) return null;

        const provider = await deps.resolveConnectionProvider(connectionId);
        const plan = deps.resolvePlan(connectionId, provider);
        if (!plan?.dimensions?.length) return null;

        // Mesma escala da rota de management: um pool com N contas do mesmo tipo tem
        // orçamento de perAccountLimit × N por dimensão, e é contra esse teto que o
        // enforce compara. Sem isso a fatia sairia N vezes menor do que a real.
        const accountCount = pool.connectionIds?.length || 1;
        const effectiveDimensions = plan.dimensions.map((dim) => ({
          ...dim,
          limit: dim.limit * accountCount,
        }));

        const snapshot = await store.poolUsageWithDimensions(poolId, effectiveDimensions);
        const dimensions = toPoolQuotaDimensions(snapshot, metadata.id);
        if (!dimensions.length) return null;

        const status: PoolQuotaStatus = { poolId, connectionId, provider, dimensions };
        if (typeof allocation.weight === "number") status.weight = allocation.weight;
        if (typeof allocation.policy === "string") status.policy = allocation.policy;
        if (typeof allocation.capValue === "number") {
          status.cap = {
            value: allocation.capValue,
            ...(allocation.capUnit !== undefined && { unit: allocation.capUnit }),
          };
        }
        return status;
      } catch {
        return null;
      }
    })
  );

  const pools = resolved.filter((entry): entry is PoolQuotaStatus => entry !== null);
  return pools.length ? pools : undefined;
}

interface DefaultDepsLoader {
  /** The injectable deps this loader provides; it runs only if one of them is missing. */
  keys: ReadonlyArray<keyof ApiKeySelfServiceDeps>;
  load: () => Promise<Partial<RequiredDeps>>;
}

// Modules are imported lazily, and only for deps the caller did not inject, so tests that
// stub a whole group never touch the real DB or network modules behind it.
const DEFAULT_DEPS_LOADERS: DefaultDepsLoader[] = [
  {
    keys: ["getCostSummary", "checkBudget", "getBudgetWindowTotal"],
    load: async () => {
      const m = await import("@/domain/costRules");
      return {
        getCostSummary: m.getCostSummary,
        checkBudget: m.checkBudget,
        getBudgetWindowTotal: m.getBudgetWindowTotal,
      };
    },
  },
  {
    keys: ["getDbInstance"],
    load: async () => ({ getDbInstance: (await import("@/lib/db/core")).getDbInstance }),
  },
  {
    keys: ["getProviderConnectionById", "getProviderConnections"],
    load: async () => {
      const m = await import("@/lib/db/providers");
      return {
        getProviderConnectionById: m.getProviderConnectionById,
        getProviderConnections: m.getProviderConnections,
      };
    },
  },
  {
    keys: ["fetchAndPersistProviderLimits"],
    load: async () => ({
      fetchAndPersistProviderLimits: (await import("@/lib/usage/providerLimits"))
        .fetchAndPersistProviderLimits,
    }),
  },
  {
    keys: ["getProviderLimitsCache"],
    load: async () => ({
      getProviderLimitsCache: (await import("@/lib/db/providerLimits")).getProviderLimitsCache,
    }),
  },
  {
    keys: ["getApiKeyUsageLimitStatus"],
    load: async () => ({
      getApiKeyUsageLimitStatus: (await import("@/lib/usage/apiKeyUsageLimits"))
        .getApiKeyUsageLimitStatus,
    }),
  },
  {
    keys: ["listTokenLimits", "getWindowUsage", "resetWindowIfElapsed"],
    load: async () => {
      const m = await import("@/lib/db/tokenLimits");
      return {
        listTokenLimits: m.listTokenLimits,
        getWindowUsage: m.getWindowUsage as unknown as RequiredDeps["getWindowUsage"],
        resetWindowIfElapsed:
          m.resetWindowIfElapsed as unknown as RequiredDeps["resetWindowIfElapsed"],
      };
    },
  },
  {
    keys: ["getKeyQuotaStatus"],
    load: async () => ({
      getKeyQuotaStatus: (await import("@/lib/db/keyQuota")).getKeyQuotaStatus,
    }),
  },
  {
    keys: ["listApiKeyUsageSlices"],
    load: async () => ({
      listApiKeyUsageSlices: (await import("@/lib/db/apiKeyUsageSlices")).listApiKeyUsageSlices,
    }),
  },
  {
    keys: ["calculateCostDetailed"],
    load: async () => ({
      calculateCostDetailed: (await import("./costCalculator")).calculateCostDetailed,
    }),
  },
  {
    keys: ["getPricingTable"],
    load: async () => ({
      getPricingTable: (await import("@/lib/db/readCache")).getCachedPricing,
    }),
  },
];

const POOL_QUOTA_LOADERS: DefaultDepsLoader[] = [
  {
    keys: ["listAllocationsForApiKey", "getPool"],
    load: async () => {
      const m = await import("@/lib/db/quotaPools");
      return {
        listAllocationsForApiKey: m.listAllocationsForApiKey as ListAllocationsForApiKeyFn,
        getPool: m.getPool as GetPoolFn,
      };
    },
  },
  {
    keys: ["resolvePlan"],
    load: async () => ({
      resolvePlan: (await import("@/lib/quota/planResolver")).resolvePlan as ResolvePlanFn,
    }),
  },
  {
    keys: ["resolveConnectionProvider"],
    load: async () => ({
      resolveConnectionProvider: (await import("@/lib/quota/connectionProvider"))
        .resolveConnectionProvider as ResolveConnectionProviderFn,
    }),
  },
  {
    keys: ["getQuotaStore"],
    load: async () => ({
      getQuotaStore: (await import("@/lib/quota/QuotaStore")).getQuotaStore as GetQuotaStoreFn,
    }),
  },
];

async function normalizeDeps(deps: ApiKeySelfServiceDeps): Promise<RequiredDeps> {
  const resolved: Partial<RequiredDeps> = {
    now: Date.now,
    quotaRefreshTracker: defaultQuotaRefreshTracker,
    listPriceCache: defaultListPriceCache,
  };
  for (const loader of [...DEFAULT_DEPS_LOADERS, ...POOL_QUOTA_LOADERS]) {
    if (loader.keys.some((key) => deps[key] === undefined)) {
      Object.assign(resolved, await loader.load());
    }
  }
  for (const [key, value] of Object.entries(deps)) {
    if (value !== undefined) (resolved as Record<string, unknown>)[key] = value;
  }
  return resolved as RequiredDeps;
}

function accountQuotaDeps(deps: RequiredDeps): AccountQuotaDeps {
  return {
    now: deps.now,
    getProviderConnectionById: deps.getProviderConnectionById,
    getProviderConnections: deps.getProviderConnections,
    getProviderLimitsCache: deps.getProviderLimitsCache,
    fetchAndPersistProviderLimits: deps.fetchAndPersistProviderLimits,
    quotaRefreshTracker: deps.quotaRefreshTracker,
  };
}

function limitDeps(deps: RequiredDeps): SelfServiceLimitDeps {
  return {
    now: deps.now,
    checkBudget: deps.checkBudget,
    getApiKeyUsageLimitStatus: deps.getApiKeyUsageLimitStatus,
    listTokenLimits: deps.listTokenLimits,
    getWindowUsage: deps.getWindowUsage,
    resetWindowIfElapsed: deps.resetWindowIfElapsed,
    getKeyQuotaStatus: deps.getKeyQuotaStatus,
  };
}

async function resolveAccountQuotas(
  metadata: ApiKeySelfServiceMetadata,
  deps: RequiredDeps,
  options: ApiKeySelfServiceOptions
) {
  if (!options.adminPreview && !hasSelfAccountQuotaScope(metadata.scopes)) return undefined;
  return resolveAccountQuotaEntries(
    {
      allowedConnections: Array.isArray(metadata.allowedConnections)
        ? metadata.allowedConnections
        : [],
      sharedQuotaProviders: metadata.sharedQuotaProviders ?? null,
    },
    accountQuotaDeps(deps)
  );
}

export async function buildApiKeySelfServiceStatus(
  metadata: ApiKeySelfServiceMetadata,
  deps: ApiKeySelfServiceDeps = {},
  options: ApiKeySelfServiceOptions = {}
) {
  if (!options.adminPreview && !hasSelfUsageScope(metadata.scopes)) {
    throw new Error("missing_self_usage_scope");
  }

  const resolvedDeps = await normalizeDeps(deps);
  const now = resolvedDeps.now();
  const summary = resolvedDeps.getCostSummary(metadata.id);

  const cost = buildCostStatus(summary, now);
  const costPeriodStartAt =
    cost.periodStartAt ?? new Date(getCurrentMonthWindow(now).periodStartAt).toISOString();
  const db = resolvedDeps.getDbInstance() as DbLike;
  const tokens = aggregateTokens(db, metadata.id, costPeriodStartAt);
  const daily = buildUsageWindowSummary(
    db,
    metadata.id,
    getUtcDayWindow(now),
    resolvedDeps.getBudgetWindowTotal
  );
  const weekly = buildUsageWindowSummary(
    db,
    metadata.id,
    getUtcIsoWeekWindow(now),
    resolvedDeps.getBudgetWindowTotal
  );
  // List-price value next to the metered spend, for the usage.cost, daily and weekly windows.
  // Cached per key and window starts, so a new day, week or budget period is never served old.
  const windowStarts = [costPeriodStartAt, daily.periodStartAt, weekly.periodStartAt];
  const listPrices = resolvedDeps.listPriceCache.memoize(
    JSON.stringify([metadata.id, ...windowStarts]),
    now,
    async () => {
      const promptBandCuts = collectLongContextCuts(await resolvedDeps.getPricingTable());
      const slices = resolvedDeps.listApiKeyUsageSlices(
        db,
        metadata.id,
        windowStarts,
        promptBandCuts
      );
      return summarizeListPrice(slices, windowStarts.length, resolvedDeps.calculateCostDetailed);
    }
  );
  const [[costListPrice, dailyListPrice, weeklyListPrice], limits, accountQuotas] =
    await Promise.all([
      listPrices,
      buildSelfServiceLimits(
        {
          id: metadata.id,
          usageLimitEnabled: metadata.usageLimitEnabled,
          dailyUsageLimitUsd: metadata.dailyUsageLimitUsd,
          weeklyUsageLimitUsd: metadata.weeklyUsageLimitUsd,
        },
        limitDeps(resolvedDeps)
      ),
      resolveAccountQuotas(metadata, resolvedDeps, options),
    ]);
  const accountQuota = accountQuotas && accountQuotas.length === 1 ? accountQuotas[0] : undefined;
  const poolQuotas = await resolvePoolQuotas(metadata, resolvedDeps);
  const poolQuota = poolQuotas && poolQuotas.length === 1 ? poolQuotas[0] : undefined;

  return {
    apiKey: {
      id: metadata.id,
      name: metadata.name,
    },
    generatedAt: new Date(now).toISOString(),
    usage: {
      cost: { ...cost, ...costListPrice },
      tokens: {
        periodStartAt: cost.periodStartAt,
        ...tokens,
      },
      daily: { ...daily, ...dailyListPrice },
      weekly: { ...weekly, ...weeklyListPrice },
    },
    limits,
    ...(accountQuotas !== undefined && { accountQuotas }),
    ...(accountQuota !== undefined && { accountQuota }),
    ...(poolQuotas !== undefined && { poolQuotas }),
    ...(poolQuota !== undefined && { poolQuota }),
  };
}

export interface SelfServiceSessionsQuery {
  project?: string | null;
  client?: string | null;
  clientSessionId?: string | null;
  from?: string | null;
  to?: string | null;
  sort?: "lastSeen" | "firstSeen" | "requests" | "tokens" | "cost";
  order?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export async function buildApiKeySelfServiceSessions(
  metadata: { id: string; scopes: string[] },
  query: SelfServiceSessionsQuery = {},
  deps: { getDbInstance?: () => unknown } = {}
) {
  if (!hasSelfUsageScope(metadata.scopes)) {
    throw new Error("missing_self_usage_scope");
  }

  const { getDbInstance: defaultGetDbInstance } = await import("../db/core");
  const db = (
    deps.getDbInstance ? deps.getDbInstance() : defaultGetDbInstance()
  ) as import("../db/adapters/types").SqliteAdapter;
  const { listAgentSessions } = await import("../db/agentSessions");

  const allowConnections = hasSelfAccountQuotaScope(metadata.scopes);

  const { sessions, total } = listAgentSessions(db, {
    apiKeyId: metadata.id,
    projectName: query.project || undefined,
    client: query.client || undefined,
    clientSessionId: query.clientSessionId || undefined,
    from: query.from || undefined,
    to: query.to || undefined,
    sort: query.sort,
    order: query.order,
    limit: query.limit,
    offset: query.offset,
  });

  const sanitizedSessions = sessions.map(({ lastConnectionId, ...session }) => ({
    ...session,
    ...(allowConnections && { lastConnectionId }),
  }));

  return {
    sessions: sanitizedSessions,
    total,
    limit: query.limit ?? 20,
    offset: query.offset ?? 0,
  };
}

export async function buildApiKeySelfServiceSessionDetail(
  metadata: { id: string; scopes: string[] },
  sessionId: string,
  deps: { getDbInstance?: () => unknown } = {}
) {
  if (!hasSelfUsageScope(metadata.scopes)) {
    throw new Error("missing_self_usage_scope");
  }

  const { getDbInstance: defaultGetDbInstance } = await import("../db/core");
  const db = (
    deps.getDbInstance ? deps.getDbInstance() : defaultGetDbInstance()
  ) as import("../db/adapters/types").SqliteAdapter;
  const { getAgentSessionById, getAgentSessionRecentUsage } = await import("../db/agentSessions");

  const session = getAgentSessionById(db, sessionId, metadata.id);
  if (!session) return null;

  const allowConnections = hasSelfAccountQuotaScope(metadata.scopes);
  const recentUsage = getAgentSessionRecentUsage(db, sessionId, 50);

  const { lastConnectionId, ...sanitizedSession } = session;
  const sanitizedUsage = recentUsage.map(({ connectionId, ...item }) => ({
    ...item,
    ...(allowConnections && { connectionId }),
  }));

  return {
    session: {
      ...sanitizedSession,
      ...(allowConnections && { lastConnectionId }),
    },
    recentRequests: sanitizedUsage,
  };
}

/** Providers of the connections a key can reach (admin self-service settings UI). */
export async function listApiKeyReachableProviders(
  allowedConnections: string[],
  deps: Pick<ApiKeySelfServiceDeps, "getProviderConnectionById" | "getProviderConnections"> = {}
) {
  const providers =
    deps.getProviderConnectionById && deps.getProviderConnections
      ? null
      : await import("@/lib/db/providers");
  return listReachableProviders(Array.isArray(allowedConnections) ? allowedConnections : [], {
    getProviderConnectionById:
      deps.getProviderConnectionById ?? providers!.getProviderConnectionById,
    getProviderConnections: deps.getProviderConnections ?? providers!.getProviderConnections,
  });
}
