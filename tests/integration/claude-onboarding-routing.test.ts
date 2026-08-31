/**
 * Validates that the routing/gateway layer actually enforces
 * `allowedConnections` for a key onboarded through the self-service link
 * route — end to end, against the real chat handler
 * (`src/sse/handlers/chat.ts` -> `src/sse/services/auth.ts`'s
 * `getProviderCredentials`), not just the DB-write side already covered by
 * the unit tests for that route.
 *
 * No live network call to Anthropic is made or claimed. The OAuth token
 * exchange is stubbed via `globalThis.fetch`, exactly like
 * `tests/unit/api/v1-me-connections-claude-route.test.ts` and
 * `tests/integration/chat-pipeline.test.ts` already do for every other
 * provider round-trip in this repo.
 *
 * Enforcement code under test (found by grepping `allowedConnections`
 * outside the DB-write path):
 *   - `src/sse/services/auth.ts` `getProviderCredentials()` — filters the
 *     candidate connection pool down to `allowedConnections` (comment
 *     "allowedConnections: restrict to specific connection IDs (from API
 *     key policy, #363)"), then intersects that with any forced/pinned
 *     connection id.
 *   - `src/sse/handlers/chat.ts` — reads `apiKeyInfo.allowedConnections`
 *     (populated by `enforceApiKeyPolicy` from the DB row) and a
 *     client-supplied `X-OmniRoute-Connection` pin header
 *     (`requestedConnectionId`), intersects/forwards both into
 *     `getProviderCredentialsWithQuotaPreflight` as `forcedConnectionId`.
 *   - On success, `withSelectedConnectionHeader()` (chatHelpers.ts) stamps
 *     the actually-selected connection id onto the response as
 *     `X-OmniRoute-Selected-Connection-Id`; empirically this header is only
 *     populated on some response shapes, so the tests below instead assert
 *     *which* connection served each request via the call-log row
 *     (`callLogsDb.getCallLogById(...).connectionId`) that
 *     `src/sse/handlers/chat.ts` writes for every completed request —
 *     the same field OmniRoute's own billing/usage dashboard relies on.
 *   - On failure (no eligible connection after the allowedConnections
 *     filter), `handleNoCredentials()` returns 401 "No active credentials
 *     for provider: claude." for a single-model request like these (404 is
 *     reserved for combo routing's internal fall-through signal).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createChatPipelineHarness } from "./_chatPipelineHarness.ts";

const harness = await createChatPipelineHarness("claude-onboarding-routing");
const {
  apiKeysDb,
  buildRequest,
  buildClaudeResponse,
  buildOpenAIResponse,
  cleanup,
  getLatestCallLog,
  handleChat,
  resetStorage,
  seedApiKey,
  seedConnection,
  settingsDb,
  waitFor,
} = harness;

const providersDb = await import("../../src/lib/db/providers.ts");
const connectRoute = await import("../../src/app/api/v1/me/connections/claude/route.ts");
const { SELF_USAGE_SCOPE } = await import("../../src/shared/constants/selfServiceScopes.ts");

/** Polls for the latest call-log row until it matches `connectionId`,
 * avoiding a race against the async call-log write and against a stale
 * "latest" row left over from an earlier request in the same test. */
async function waitForCallLogFrom(connectionId: string) {
  return waitFor(async () => {
    const log = await getLatestCallLog();
    return log?.connectionId === connectionId ? log : null;
  });
}

/** Captures the id of the current "latest" call-log row (or `null` if the
 * table is empty) so a later assertion can prove a fresh row was produced,
 * rather than being satisfied by a pre-existing row that already matches
 * the expected connection id. */
async function captureCallLogMarker() {
  const log = await getLatestCallLog();
  return log?.id ?? null;
}

/** Like `waitForCallLogFrom`, but additionally requires the matching row's
 * id to differ from `sinceId` — i.e. it must be a row genuinely produced
 * *after* `sinceId` was captured, not a stale leftover from an earlier
 * request in the same test that happens to already have the right
 * `connectionId`. */
async function waitForNewCallLogFrom(connectionId: string, sinceId: string | null) {
  return waitFor(async () => {
    const log = await getLatestCallLog();
    if (!log || (sinceId !== null && log.id === sinceId)) return null;
    return log.connectionId === connectionId ? log : null;
  });
}

/** The link route requires the caller's key to carry `self:usage`
 * (see `hasSelfUsageScope` in the route) — the harness's generic
 * `seedApiKey` doesn't grant scopes, so onboarding tests create the key
 * directly, then reuse `seedApiKey`-style `allowedConnections` seeding via
 * `updateApiKeyPermissions`. */
async function seedSelfServiceApiKey(name: string, allowedConnections: string[] = []) {
  const key = await apiKeysDb.createApiKey(name, `machine-${name}`, [SELF_USAGE_SCOPE]);
  if (allowedConnections.length > 0) {
    await apiKeysDb.updateApiKeyPermissions(key.id, { allowedConnections });
  }
  return key;
}

const originalFetch = globalThis.fetch;

const validExchangeBody = {
  code: "auth-code",
  redirectUri: "http://127.0.0.1:56121/callback",
  codeVerifier: "verifier-123",
  state: "state-abc",
};

/** Mirrors tests/unit/api/v1-me-connections-claude-route.test.ts: stubs the
 * OAuth token-exchange POST. No `oauth_account` in the response, so the
 * best-effort bootstrap upsert-by-email is a no-op and every call creates a
 * brand-new connection (needed below to get two *distinct* Claude
 * connections for the cross-key isolation test). */
function mockSuccessfulClaudeExchange(tokenSuffix: string) {
  globalThis.fetch = (async () =>
    Response.json({
      access_token: `test-access-token-${tokenSuffix}`,
      refresh_token: `test-refresh-token-${tokenSuffix}`,
      expires_in: 3600,
    })) as typeof fetch;
}

function postConnectRoute(bearer: string) {
  return connectRoute.POST(
    new Request("http://localhost/api/v1/me/connections/claude", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
      body: JSON.stringify(validExchangeBody),
    })
  );
}

/** Drives the real link route (mocked exchange) to link a fresh Claude
 * connection onto `apiKey`, exactly as the portal onboarding flow does. */
async function linkNewClaudeConnection(apiKey: string, tokenSuffix: string) {
  mockSuccessfulClaudeExchange(tokenSuffix);
  const res = await postConnectRoute(apiKey);
  assert.equal(res.status, 200, `expected the link route to succeed for ${tokenSuffix}`);
  const body = (await res.json()) as { status: string; connectionId: string; provider: string };
  assert.equal(body.status, "linked");
  assert.equal(body.provider, "claude");
  assert.equal(typeof body.connectionId, "string");
  return body.connectionId;
}

test.before(async () => {
  await settingsDb.updateSettings({ requireLogin: false });
});

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  globalThis.fetch = originalFetch;
  await cleanup();
});

// ─────────────────────────────────────────────────────────────────────────
// 1. Onboarding via the real link route merges allowedConnections without
//    dropping anything, AND both the pre-existing and newly-linked
//    connections are actually usable by the real chat/routing code.
// ─────────────────────────────────────────────────────────────────────────

test("linking via the self-service route preserves prior allowedConnections and both connections route real chat requests", async () => {
  const preexistingOpenai = await seedConnection("openai", { apiKey: "sk-openai-preexisting" });
  const devKey = await seedSelfServiceApiKey("dev-key-with-prior-connection", [
    preexistingOpenai.id,
  ]);

  const newClaudeConnectionId = await linkNewClaudeConnection(devKey.key, "dev");

  // ── DB-level invariant (what Tasks 3/4 already unit-test, re-verified here) ──
  const row = await apiKeysDb.getApiKeyById(devKey.id);
  const allowed = row?.allowedConnections ?? [];
  assert.ok(
    allowed.includes(preexistingOpenai.id),
    "pre-existing connection must survive the link"
  );
  assert.ok(allowed.includes(newClaudeConnectionId), "newly linked connection must be present");
  assert.equal(allowed.length, 2, "nothing extra should have been added or dropped");

  // ── Routing-layer invariant: the pre-existing connection still routes ──
  globalThis.fetch = async () => buildOpenAIResponse("still works after linking");
  const openaiResponse = await handleChat(
    buildRequest({
      authKey: devKey.key,
      body: {
        model: "openai/gpt-4o-mini",
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      },
    })
  );
  assert.equal(openaiResponse.status, 200, "the pre-existing connection must still route");
  const openaiCallLog = await waitForCallLogFrom(preexistingOpenai.id);
  assert.ok(openaiCallLog, "expected a call log for the pre-existing connection");

  // ── Routing-layer invariant: the newly linked Claude connection routes ──
  globalThis.fetch = async () => buildClaudeResponse("hello from the newly linked connection");
  const claudeResponse = await handleChat(
    buildRequest({
      authKey: devKey.key,
      body: {
        model: "claude/claude-sonnet-4-6",
        stream: false,
        messages: [{ role: "user", content: "hello claude" }],
      },
    })
  );
  assert.equal(claudeResponse.status, 200, "the newly linked Claude connection must route");
  const claudeCallLog = await waitForCallLogFrom(newClaudeConnectionId);
  assert.ok(claudeCallLog, "the request must be served by the connection that was just linked");
});

// ─────────────────────────────────────────────────────────────────────────
// 2. Cross-key isolation: a Claude connection linked to key B must never be
//    selectable/usable by key A, even when key A explicitly asks for it.
// ─────────────────────────────────────────────────────────────────────────

test("a key can never route through a Claude connection that belongs to a different key", async () => {
  const keyA = await seedSelfServiceApiKey("key-a");
  const keyB = await seedSelfServiceApiKey("key-b");

  const connA = await linkNewClaudeConnection(keyA.key, "key-a");
  const connB = await linkNewClaudeConnection(keyB.key, "key-b");
  assert.notEqual(connA, connB, "the two keys must end up with distinct Claude connections");

  const rowA = await apiKeysDb.getApiKeyById(keyA.id);
  assert.deepEqual(rowA?.allowedConnections, [connA]);
  assert.ok(!rowA?.allowedConnections.includes(connB), "key A must not see key B's connection");

  globalThis.fetch = async () => buildClaudeResponse("served by A's own connection");

  // 2a. Normal request (no pin): key A must be served by its OWN connection,
  //     never key B's — proving the default selection path is scoped.
  const normalResponse = await handleChat(
    buildRequest({
      authKey: keyA.key,
      body: {
        model: "claude/claude-sonnet-4-6",
        stream: false,
        messages: [{ role: "user", content: "hi" }],
      },
    })
  );
  assert.equal(normalResponse.status, 200);
  const normalCallLog = await waitForCallLogFrom(connA);
  assert.ok(normalCallLog, "key A's un-pinned request must be served by its own connection");

  // 2b. Explicit attempt to pin key A's request onto key B's connection via
  //     the client-facing `X-OmniRoute-Connection` header. The routing layer
  //     must never honor a pin outside the caller's own allowedConnections:
  //     it must either fall back to key A's own connection, or fail outright
  //     — but it must NEVER serve the request from key B's connection.
  // Capture a marker BEFORE firing the pinned request so the assertion below
  // can only be satisfied by a call-log row this request itself produced —
  // not by 2a's already-confirmed connA row still sitting as "latest".
  const beforePinnedMarker = await captureCallLogMarker();
  const pinnedResponse = await handleChat(
    buildRequest({
      authKey: keyA.key,
      headers: { "X-OmniRoute-Connection": connB },
      body: {
        model: "claude/claude-sonnet-4-6",
        stream: false,
        messages: [{ role: "user", content: "try to steal B's connection" }],
      },
    })
  );
  if (pinnedResponse.status === 200) {
    const pinnedCallLog = await waitForNewCallLogFrom(connA, beforePinnedMarker);
    assert.ok(
      pinnedCallLog,
      "if the request succeeds at all, it must fall back to key A's own connection, never key B's " +
        "(and this must be a fresh row produced by this request, not 2a's stale connA row)"
    );
  } else {
    assert.equal(pinnedResponse.status, 401, "an ineligible pinned connection is rejected as 401");
  }

  // 2c. A key with NO allowed Claude connection at all cannot be tricked
  //     into using another key's connection either — this is the sharpest
  //     form of "rejected when the target connection is NOT in
  //     allowedConnections": the provider has zero eligible connections for
  //     this key once the allowedConnections filter runs, independent of
  //     the pin logic's fallback behavior exercised in 2b.
  const bystanderOpenai = await seedConnection("openai", { apiKey: "sk-bystander" });
  const keyC = await seedApiKey({
    name: "key-c-no-claude-access",
    allowedConnections: [bystanderOpenai.id],
  });
  const rejectedResponse = await handleChat(
    buildRequest({
      authKey: keyC.key,
      headers: { "X-OmniRoute-Connection": connB },
      body: {
        model: "claude/claude-sonnet-4-6",
        stream: false,
        messages: [{ role: "user", content: "try to steal B's connection" }],
      },
    })
  );
  assert.equal(rejectedResponse.status, 401);
  const rejectedBody = (await rejectedResponse.json()) as { error?: { message?: string } };
  assert.match(
    String(rejectedBody?.error?.message ?? ""),
    /No active credentials for provider: claude/
  );
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Direct unit-level confirmation of the exact filter documented above,
//    isolated from HTTP/telemetry noise, using the same helper chat.ts
//    calls in production.
// ─────────────────────────────────────────────────────────────────────────

test("getProviderCredentials never returns a connection outside allowedConnections (direct)", async () => {
  const { getProviderCredentials } = await import("../../src/sse/services/auth.ts");

  const allowedConn = await providersDb.createProviderConnection({
    provider: "claude",
    authType: "oauth",
    name: "allowed-claude-connection",
    email: "allowed@example.com",
    accessToken: "access-allowed",
    refreshToken: "refresh-allowed",
  });
  const foreignConn = await providersDb.createProviderConnection({
    provider: "claude",
    authType: "oauth",
    name: "foreign-claude-connection",
    email: "foreign@example.com",
    accessToken: "access-foreign",
    refreshToken: "refresh-foreign",
  });

  for (let i = 0; i < 8; i++) {
    const creds = (await getProviderCredentials("claude", null, [allowedConn.id])) as {
      connectionId?: string;
    } | null;
    assert.ok(creds && creds.connectionId, "the allowed connection must be selectable");
    assert.equal(creds.connectionId, allowedConn.id);
    assert.notEqual(creds.connectionId, foreignConn.id);
  }

  // Forcing the foreign connection id explicitly must not surface it either.
  const forcedForeign = (await getProviderCredentials("claude", null, [allowedConn.id], null, {
    forcedConnectionId: foreignConn.id,
  })) as { connectionId?: string } | null;
  assert.notEqual(forcedForeign?.connectionId, foreignConn.id);
});
