import { hasSelfAccountQuotaScope, hasSelfUsageScope } from "@/shared/constants/selfServiceScopes";
import { supportsProviderQuota } from "@/shared/utils/providerQuotaVisibility";

type JsonRecord = Record<string, unknown>;
type DateLike = number | string | Date | null | undefined;

interface ApiKeySelfServiceMetadata {
  id: string;
  name: string;
  scopes: string[];
  allowedConnections: string[];
}

interface StatementLike {
  get: (...params: unknown[]) => unknown;
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
  source: "manual"
) => Promise<{ usage: JsonRecord }>;

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

interface ApiKeySelfServiceDeps {
  now?: () => number;
  getCostSummary?: GetCostSummaryFn;
  checkBudget?: CheckBudgetFn;
  getDbInstance?: GetDbInstanceFn;
  getProviderConnectionById?: GetProviderConnectionByIdFn;
  getProviderConnections?: GetProviderConnectionsFn;
  fetchAndPersistProviderLimits?: FetchAndPersistProviderLimitsFn;
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

interface AccountQuotaConnection {
  id: string;
  provider: string;
  lookupFailed?: boolean;
  providerSpecificData?: unknown;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function roundNumber(value: number, precision = 6): number {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(precision));
}

function dateMsOrNull(value: DateLike): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (value instanceof Date) {
    const parsed = value.getTime();
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function isoOrNull(value: DateLike): string | null {
  const timestamp = dateMsOrNull(value);
  return timestamp === null ? null : new Date(timestamp).toISOString();
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

function unavailableAccountQuota(reason: string) {
  return { available: false, reason };
}

function quotaWindow(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as JsonRecord;
  const usedPercentage = toNumber(record.usedPercentage ?? record.used, Number.NaN);
  const remainingPercentage = toNumber(
    record.remainingPercentage ?? record.remaining,
    Number.isFinite(usedPercentage) ? 100 - usedPercentage : Number.NaN
  );
  if (!Number.isFinite(usedPercentage) && !Number.isFinite(remainingPercentage)) return null;

  return {
    usedPercentage: Number.isFinite(usedPercentage)
      ? roundNumber(usedPercentage, 2)
      : roundNumber(100 - remainingPercentage, 2),
    remainingPercentage: Number.isFinite(remainingPercentage)
      ? roundNumber(remainingPercentage, 2)
      : roundNumber(100 - usedPercentage, 2),
    resetAt: isoOrNull(record.resetAt as DateLike),
  };
}

function normalizePlan(value: unknown): unknown {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  return undefined;
}

function isSupportedProvider(
  provider: string,
  connection?: { provider?: string; providerSpecificData?: unknown }
): boolean {
  return supportsProviderQuota(provider, connection);
}

function getConnectionIdentity(value: unknown): AccountQuotaConnection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as JsonRecord;
  if (record.isActive === false) return null;

  const id = typeof record.id === "string" ? record.id : "";
  const provider = typeof record.provider === "string" ? record.provider : "";
  if (!id || !provider) return null;

  return {
    id,
    provider,
    providerSpecificData: record.providerSpecificData,
  };
}

async function listAccountQuotaConnections(
  metadata: ApiKeySelfServiceMetadata,
  deps: RequiredDeps
) {
  const allowedConnections = Array.isArray(metadata.allowedConnections)
    ? metadata.allowedConnections
    : [];

  const rawConnections =
    allowedConnections.length > 0
      ? await Promise.all(
          allowedConnections.map(async (id) => {
            try {
              return await deps.getProviderConnectionById(id);
            } catch {
              return { id, provider: "unknown", lookupFailed: true };
            }
          })
        )
      : await deps.getProviderConnections({ isActive: true }).catch(() => []);

  const connections: AccountQuotaConnection[] = [];
  const seen = new Set<string>();
  for (const rawConnection of rawConnections) {
    if (
      rawConnection &&
      typeof rawConnection === "object" &&
      !Array.isArray(rawConnection) &&
      (rawConnection as JsonRecord).lookupFailed === true
    ) {
      const record = rawConnection as JsonRecord;
      const id = typeof record.id === "string" ? record.id : "";
      const provider = typeof record.provider === "string" ? record.provider : "unknown";
      if (!id || seen.has(id)) continue;
      seen.add(id);
      connections.push({ id, provider, lookupFailed: true });
      continue;
    }

    const connection = getConnectionIdentity(rawConnection);
    if (!connection || seen.has(connection.id)) continue;
    seen.add(connection.id);
    connections.push(connection);
  }

  return connections;
}

function normalizeQuotaWindows(quotas: JsonRecord | null) {
  if (!quotas) return null;

  const normalized: Record<string, ReturnType<typeof quotaWindow>> = {};
  for (const [key, value] of Object.entries(quotas)) {
    const window = quotaWindow(value);
    if (window) normalized[key] = window;
  }

  return Object.keys(normalized).length > 0 ? normalized : null;
}

async function resolveConnectionAccountQuota(
  connection: AccountQuotaConnection,
  deps: RequiredDeps
) {
  if (connection.lookupFailed) {
    return {
      provider: connection.provider,
      connectionId: connection.id,
      shared: true,
      ...unavailableAccountQuota("connection_lookup_failed"),
    };
  }

  if (!isSupportedProvider(connection.provider, connection)) {
    return {
      provider: connection.provider,
      connectionId: connection.id,
      shared: true,
      ...unavailableAccountQuota("not_supported"),
    };
  }

  try {
    const result = await deps.fetchAndPersistProviderLimits(connection.id, "manual");
    const usage = result.usage as JsonRecord;
    const quotas =
      usage.quotas && typeof usage.quotas === "object" && !Array.isArray(usage.quotas)
        ? (usage.quotas as JsonRecord)
        : null;
    const normalizedQuotas = normalizeQuotaWindows(quotas);
    const plan = normalizePlan(usage.plan);

    if (!normalizedQuotas && plan === undefined) {
      return {
        provider: connection.provider,
        connectionId: connection.id,
        shared: true,
        ...unavailableAccountQuota("not_available"),
      };
    }

    return {
      provider: connection.provider,
      connectionId: connection.id,
      shared: true,
      ...(plan !== undefined && { plan }),
      ...(normalizedQuotas && { quotas: normalizedQuotas }),
    };
  } catch {
    return {
      provider: connection.provider,
      connectionId: connection.id,
      shared: true,
      ...unavailableAccountQuota("fetch_failed"),
    };
  }
}

async function resolveAccountQuotas(metadata: ApiKeySelfServiceMetadata, deps: RequiredDeps) {
  if (!hasSelfAccountQuotaScope(metadata.scopes)) return undefined;

  const connections = await listAccountQuotaConnections(metadata, deps);
  return Promise.all(
    connections.map((connection) => resolveConnectionAccountQuota(connection, deps))
  );
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

type RequiredDeps = Required<ApiKeySelfServiceDeps>;

async function normalizeDeps(deps: ApiKeySelfServiceDeps): Promise<RequiredDeps> {
  const costRules =
    deps.getCostSummary && deps.checkBudget ? null : await import("@/domain/costRules");
  const dbCore = deps.getDbInstance ? null : await import("@/lib/db/core");
  const localDb =
    deps.getProviderConnectionById && deps.getProviderConnections
      ? null
      : await import("@/lib/db/providers");
  const providerLimits = deps.fetchAndPersistProviderLimits
    ? null
    : await import("@/lib/usage/providerLimits");
  const quotaPools =
    deps.listAllocationsForApiKey && deps.getPool ? null : await import("@/lib/db/quotaPools");
  const planResolver = deps.resolvePlan ? null : await import("@/lib/quota/planResolver");
  const connectionProvider = deps.resolveConnectionProvider
    ? null
    : await import("@/lib/quota/connectionProvider");
  const quotaStore = deps.getQuotaStore ? null : await import("@/lib/quota/QuotaStore");

  return {
    now: deps.now ?? Date.now,
    getCostSummary: deps.getCostSummary ?? costRules!.getCostSummary,
    checkBudget: deps.checkBudget ?? costRules!.checkBudget,
    getDbInstance: deps.getDbInstance ?? dbCore!.getDbInstance,
    getProviderConnectionById: deps.getProviderConnectionById ?? localDb!.getProviderConnectionById,
    getProviderConnections: deps.getProviderConnections ?? localDb!.getProviderConnections,
    fetchAndPersistProviderLimits:
      deps.fetchAndPersistProviderLimits ?? providerLimits!.fetchAndPersistProviderLimits,
    listAllocationsForApiKey:
      deps.listAllocationsForApiKey ??
      (quotaPools!.listAllocationsForApiKey as ListAllocationsForApiKeyFn),
    getPool: deps.getPool ?? (quotaPools!.getPool as GetPoolFn),
    resolveConnectionProvider:
      deps.resolveConnectionProvider ??
      (connectionProvider!.resolveConnectionProvider as ResolveConnectionProviderFn),
    resolvePlan: deps.resolvePlan ?? (planResolver!.resolvePlan as ResolvePlanFn),
    getQuotaStore: deps.getQuotaStore ?? (quotaStore!.getQuotaStore as GetQuotaStoreFn),
  };
}

export async function buildApiKeySelfServiceStatus(
  metadata: ApiKeySelfServiceMetadata,
  deps: ApiKeySelfServiceDeps = {}
) {
  if (!hasSelfUsageScope(metadata.scopes)) {
    throw new Error("missing_self_usage_scope");
  }

  const resolvedDeps = await normalizeDeps(deps);
  const summary = resolvedDeps.getCostSummary(metadata.id);
  resolvedDeps.checkBudget(metadata.id);

  const cost = buildCostStatus(summary, resolvedDeps.now());
  const tokens = aggregateTokens(
    resolvedDeps.getDbInstance() as DbLike,
    metadata.id,
    cost.periodStartAt ??
      new Date(getCurrentMonthWindow(resolvedDeps.now()).periodStartAt).toISOString()
  );
  const accountQuotas = await resolveAccountQuotas(metadata, resolvedDeps);
  const accountQuota = accountQuotas && accountQuotas.length === 1 ? accountQuotas[0] : undefined;
  const poolQuotas = await resolvePoolQuotas(metadata, resolvedDeps);
  const poolQuota = poolQuotas && poolQuotas.length === 1 ? poolQuotas[0] : undefined;

  return {
    apiKey: {
      id: metadata.id,
      name: metadata.name,
    },
    usage: {
      cost,
      tokens: {
        periodStartAt: cost.periodStartAt,
        ...tokens,
      },
    },
    ...(accountQuotas !== undefined && { accountQuotas }),
    ...(accountQuota !== undefined && { accountQuota }),
    ...(poolQuotas !== undefined && { poolQuotas }),
    ...(poolQuota !== undefined && { poolQuota }),
  };
}
