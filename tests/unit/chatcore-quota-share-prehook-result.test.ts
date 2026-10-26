/**
 * The quota-share pre-hook must return the same error-result shape every other
 * pre-upstream rejection in handleChatCore returns (createErrorResult).
 *
 * It used to return a bare `Response`. Callers read `result.response.headers`,
 * got `undefined.headers`, threw "Cannot read properties of undefined (reading
 * 'headers')", and the 429 became a 502 — which the combo then treated as a
 * provider failure and used to skip every remaining target of that provider.
 */

import test from "node:test";
import assert from "node:assert/strict";

const { runQuotaSharePreHook } =
  await import("../../open-sse/handlers/chatCore/quotaSharePreHook.ts");

function baseArgs(decision: unknown) {
  let finalized = 0;
  return {
    args: {
      apiKeyInfo: { id: "key-1" },
      credentials: { connectionId: "conn-1" },
      provider: "claude",
      model: "claude-opus-5-5",
      isCombo: true,
      comboStepId: null,
      comboExecutionKey: null,
      finalizePendingRequest: () => {
        finalized += 1;
      },
      enforce: async () => decision,
    },
    finalizedCount: () => finalized,
  };
}

test("a block decision returns a 429 error result with a readable response", async () => {
  const { args, finalizedCount } = baseArgs({
    kind: "block",
    reason: "Provider claude quota window is saturated; no shared capacity available",
    httpStatus: 429,
    retryAfterSeconds: 42,
  });

  const result = await runQuotaSharePreHook(args);

  assert.ok(result, "expected a block result");
  assert.equal(result.success, false);
  assert.equal(result.status, 429);
  assert.ok(result.response instanceof Response, "result.response must be a Response");
  assert.equal(result.response.status, 429);
  assert.equal(result.response.headers.get("Retry-After"), "42");
  assert.match(result.error, /saturated/);
  assert.equal(finalizedCount(), 1);
});

test("an allow decision returns null", async () => {
  const { args, finalizedCount } = baseArgs({ kind: "allow" });

  assert.equal(await runQuotaSharePreHook(args), null);
  assert.equal(finalizedCount(), 0);
});
