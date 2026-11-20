import test from "node:test";
import assert from "node:assert/strict";

const { getUsageForProvider } = await import("../../open-sse/services/usage.ts");

const originalFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

const TOKEN = "sk-ant-oat01-TESTE0123456789abcdefghijKLMNOP";

test("claude usage is skipped (no network, no expiry signal) when scopes lack user:profile", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    throw new Error("must not call upstream");
  }) as typeof fetch;

  const usage: any = await getUsageForProvider({
    provider: "claude",
    accessToken: TOKEN,
    providerSpecificData: { scopes: ["user:inference"], authMethod: "setup_token" },
  });

  assert.equal(calls, 0);
  assert.match(String(usage.message), /user:profile/);
  assert.equal(usage.quotas, undefined);
  assert.doesNotMatch(String(usage.message), /expired|unauthorized|invalid/i);
});

test("claude usage still queries upstream when scopes include user:profile", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response("{}", { status: 500 });
  }) as typeof fetch;
  await getUsageForProvider({
    provider: "claude",
    accessToken: "at-normal",
    providerSpecificData: { scopes: ["user:inference", "user:profile"] },
  });
  assert.ok(calls > 0);
});
