// Routing: header-derived quota of setup-token claude connections feeds the quota cache.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-claude-hq-route-"));

import test from "node:test";
import assert from "node:assert/strict";
import {
  getQuotaWeightedRemainingPercent,
  isAccountQuotaExhausted,
  __clearForTests,
} from "../../src/domain/quotaCache.ts";
import {
  recordClaudeHeaderQuota,
  clearClaudeHeaderQuota,
} from "../../src/lib/quota/claudeHeaderQuota.ts";

const SETUP = { authMethod: "setup_token", scopes: ["user:inference"] };
const hdr = (util5: string, util7: string) => {
  const t = Math.floor(Date.now() / 1000);
  return new Headers({
    "anthropic-ratelimit-unified-5h-utilization": util5,
    "anthropic-ratelimit-unified-5h-reset": String(t + 3600),
    "anthropic-ratelimit-unified-7d-utilization": util7,
    "anthropic-ratelimit-unified-7d-reset": String(t + 86400),
  });
};
const tick = () => new Promise((r) => setTimeout(r, 50));
const persist = async () => {};

test("setup_token reading weighs in routing (min remaining across windows)", async () => {
  __clearForTests();
  clearClaudeHeaderQuota();
  recordClaudeHeaderQuota("r1", hdr("0.2", "0.6"), Date.now(), {
    providerSpecificData: SETUP,
    persist,
  });
  await tick();
  assert.equal(getQuotaWeightedRemainingPercent("r1"), 40);
  assert.equal(isAccountQuotaExhausted("r1"), false);
});

test("all windows used mark the account exhausted until reset", async () => {
  __clearForTests();
  clearClaudeHeaderQuota();
  recordClaudeHeaderQuota("r2", hdr("1", "1"), Date.now(), {
    providerSpecificData: SETUP,
    persist,
  });
  await tick();
  assert.equal(isAccountQuotaExhausted("r2"), true);
});

test("regression: OAuth connection never enters the cache from headers", async () => {
  __clearForTests();
  clearClaudeHeaderQuota();
  recordClaudeHeaderQuota("r3", hdr("0.9", "0.9"), Date.now(), {
    providerSpecificData: { scopes: ["user:profile"] },
    persist,
  });
  await tick();
  assert.equal(getQuotaWeightedRemainingPercent("r3"), null);
});
