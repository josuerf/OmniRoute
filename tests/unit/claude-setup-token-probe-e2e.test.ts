// E2E: real DB + real executor URL/headers + local http stub (never the real upstream).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-claude-probe-e2e-"));

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import {
  SELF_ACCOUNT_QUOTA_SCOPE,
  SELF_USAGE_SCOPE,
} from "../../src/shared/constants/selfServiceScopes.ts";
import { clearClaudeHeaderQuota } from "../../src/lib/quota/claudeHeaderQuota.ts";
import { buildApiKeySelfServiceStatus } from "../../src/lib/usage/apiKeySelfService.ts";
import { probeDueClaudeSetupTokenConnections } from "../../src/lib/oauth/utils/claudeSetupTokenProbe.ts";
import { createProviderConnection, getProviderConnectionById } from "../../src/lib/db/providers.ts";

type Loose = {
  available?: boolean;
  quotaSource?: string;
  quotas: Record<string, unknown>;
  authMethod?: string;
  reason?: string;
  lastErrorType?: string;
  providerSpecificData: { lastProbeAt?: string; lastProbeStatus?: number };
};

const PORT = 21802;
const TOKEN = ["sk", "ant", "oat01", "TESTEe2eabcdefghijklmnopqrstuv"].join("-");
const KEY = "key-A";
const ON = { CLAUDE_SETUP_TOKEN_PROBE_INTERVAL_HOURS: "24" };
const OFF = { CLAUDE_SETUP_TOKEN_PROBE_INTERVAL_HOURS: "0" };

let mode: 200 | 401 = 200;
const seen: Array<{ url: string; auth: string | undefined; body: string }> = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.push({ url: req.url ?? "", auth: req.headers.authorization, body });
    if (mode === 401) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "authentication_error" } }));
      return;
    }
    res.writeHead(200, {
      "content-type": "application/json",
      "anthropic-ratelimit-unified-5h-utilization": "0.4",
      "anthropic-ratelimit-unified-5h-reset": String(Math.floor(Date.now() / 1000) + 3600),
      "anthropic-ratelimit-unified-5h-status": "allowed",
      "anthropic-ratelimit-unified-7d-utilization": "0.1",
      "anthropic-ratelimit-unified-7d-reset": String(Math.floor(Date.now() / 1000) + 86400),
      "anthropic-ratelimit-unified-7d-status": "allowed",
    });
    res.end(JSON.stringify({ id: "msg_stub", type: "message", content: [] }));
  });
});

function statusDeps() {
  return {
    now: () => Date.now(),
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
    getProviderConnectionById,
    getProviderConnections: async () => [],
    fetchAndPersistProviderLimits: async (id: string) => ({
      connection: { id },
      usage: { message: "skipped" },
      cache: {},
    }),
  };
}

async function me(connectionId: string) {
  const status = await buildApiKeySelfServiceStatus(
    {
      id: KEY,
      name: "k",
      scopes: [SELF_USAGE_SCOPE, SELF_ACCOUNT_QUOTA_SCOPE],
      allowedConnections: [connectionId],
    } as never,
    statusDeps() as never
  );
  return (status as { accountQuotas: Array<Loose> }).accountQuotas[0];
}

test("probe e2e against a local stub: 200 feeds quota, 401 revokes, 0 disables", async () => {
  await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));
  process.env.CLAUDE_UPSTREAM_BASE_URL = `http://127.0.0.1:${PORT}`;
  clearClaudeHeaderQuota();
  try {
    const created = (await createProviderConnection({
      provider: "claude",
      authType: "oauth",
      name: "probe-e2e",
      accessToken: TOKEN,
      refreshToken: null,
      expiresAt: null,
      isActive: true,
      testStatus: "active",
      providerSpecificData: {
        authMethod: "setup_token",
        ownerKeyId: KEY,
        scopes: ["user:inference"],
        linkedAt: "2026-05-01T10:00:00.000Z",
      },
    })) as { id: string };

    // disabled: no call at all
    const off = await probeDueClaudeSetupTokenConnections({ env: OFF });
    assert.deepEqual(off, { probed: 0, disabled: true });
    assert.equal(seen.length, 0);

    // 200: quota saved and visible in /me/status
    mode = 200;
    const first = await probeDueClaudeSetupTokenConnections({ env: ON });
    assert.equal(first.probed, 1);
    assert.equal(seen.length, 1);
    assert.match(seen[0].url, /^\/v1\/messages/);
    assert.equal(seen[0].auth, `Bearer ${TOKEN}`);
    const sent = JSON.parse(seen[0].body);
    assert.equal(sent.max_tokens, 1);
    assert.match(sent.model, /haiku/);

    const ok = await me(created.id);
    assert.equal(ok.available, true);
    assert.equal(ok.quotaSource, "response_headers");
    assert.ok(Object.keys(ok.quotas).length >= 1);
    assert.equal(ok.authMethod, "setup_token");
    const stored = (await getProviderConnectionById(created.id)) as Loose;
    assert.ok(stored.providerSpecificData.lastProbeAt);
    assert.equal(stored.providerSpecificData.lastProbeStatus, 200);

    // not due again right away
    const again = await probeDueClaudeSetupTokenConnections({ env: ON });
    assert.equal(again.probed, 0);
    assert.equal(seen.length, 1);

    // a day later the stub rejects the token: revoked through the spike path
    mode = 401;
    const later = await probeDueClaudeSetupTokenConnections({
      env: ON,
      now: () => Date.now() + 25 * 3_600_000,
    });
    assert.equal(later.probed, 1);
    assert.equal(seen.length, 2);
    const revoked = await me(created.id);
    assert.equal(revoked.available, false);
    assert.equal(revoked.reason, "token_revoked");
    assert.equal(revoked.authMethod, "setup_token");
    const row = (await getProviderConnectionById(created.id)) as Loose;
    assert.equal(row.lastErrorType, "token_revoked");

    // a revoked connection is never probed again
    const never = await probeDueClaudeSetupTokenConnections({
      env: ON,
      now: () => Date.now() + 80 * 3_600_000,
    });
    assert.equal(never.probed, 0);
    assert.equal(seen.length, 2);
    assert.equal(JSON.stringify([ok, revoked]).includes(TOKEN), false);
  } finally {
    delete process.env.CLAUDE_UPSTREAM_BASE_URL;
    await new Promise((r) => server.close(r));
  }
});
