/**
 * Focused unit tests for `exchangeAndPersistConnection`
 * (src/lib/oauth/exchangeAndPersistConnection.ts), extracted from the
 * `exchange` action of `src/app/api/oauth/[provider]/[action]/route.ts`.
 *
 * These call the extracted function directly (no route/HTTP layer) — the
 * route's own end-to-end coverage lives in
 * `tests/unit/oauth-exchange-route-characterization.test.ts` and
 * `tests/unit/oauth-grok-cli-browser.test.ts`.
 *
 * NOTE on file location: `tests/unit/oauth/**` is NOT one of the collected
 * globs in `package.json`'s `test` script (see the brace list in the second
 * `tests/unit/{...}/**` entry, and the mirrored COLLECTORS list in
 * `scripts/check/check-test-discovery.mjs`), so a test placed there would be
 * a brand-new orphan that `check:test-discovery` explicitly fails on
 * ("teste que não roda é o falso verde definitivo"). Placed under
 * `tests/unit/lib/oauth/` instead — `tests/unit/lib/**` is already a
 * collected glob and already holds other `src/lib/**` unit tests — so this
 * test actually runs in `npm test` / CI.
 *
 * Uses xai-oauth (authorization_code_pkce, single token-endpoint fetch, no
 * secondary bootstrap call) as the exercised provider, same choice as the
 * route characterization test, for a minimal mock surface.
 *
 * DB handles released in test.after (CLAUDE.md learning: unreleased SQLite
 * handles hang node:test).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "omniroute-exchange-and-persist-connection-")
);
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../../../src/lib/db/core.ts");
const providersDb = await import("../../../../src/lib/db/providers.ts");
const { exchangeAndPersistConnection } =
  await import("../../../../src/lib/oauth/exchangeAndPersistConnection.ts");

const originalFetch = globalThis.fetch;

test.after(() => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

function createJwt(payload: Record<string, unknown>) {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.signature`;
}

test("success: exchanges the code and creates a new persisted connection with the documented shape", async () => {
  const idToken = createJwt({ email: "unit-user@example.com", name: "Unit User" });
  globalThis.fetch = async () =>
    Response.json({
      access_token: "unit-access",
      refresh_token: "unit-refresh",
      id_token: idToken,
      expires_in: 3600,
    });

  const result = await exchangeAndPersistConnection("xai-oauth", {
    code: "auth-code",
    redirectUri: "http://127.0.0.1:56121/callback",
    codeVerifier: "verifier",
  });

  assert.equal(typeof result.connection.id, "string");
  assert.equal(result.connection.provider, "xai-oauth");
  assert.equal(result.connection.email, "unit-user@example.com");

  // Actually persisted (create path), not just shaped in the return value.
  const rows = await providersDb.getProviderConnections({ provider: "xai-oauth" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, result.connection.id);
  assert.equal(rows[0].accessToken, "unit-access");
});

test("upsert: a second exchange for the same provider+email updates the existing connection instead of creating a duplicate", async () => {
  const idToken = createJwt({ email: "upsert-user@example.com", name: "Upsert User" });
  globalThis.fetch = async () =>
    Response.json({
      access_token: "first-access",
      refresh_token: "first-refresh",
      id_token: idToken,
      expires_in: 3600,
    });

  const first = await exchangeAndPersistConnection("xai-oauth", {
    code: "auth-code-1",
    redirectUri: "http://127.0.0.1:56121/callback",
    codeVerifier: "verifier",
  });

  globalThis.fetch = async () =>
    Response.json({
      access_token: "second-access",
      refresh_token: "second-refresh",
      id_token: idToken,
      expires_in: 3600,
    });

  const second = await exchangeAndPersistConnection("xai-oauth", {
    code: "auth-code-2",
    redirectUri: "http://127.0.0.1:56121/callback",
    codeVerifier: "verifier",
  });

  assert.equal(second.connection.id, first.connection.id, "must update, not duplicate");

  const rows = await providersDb.getProviderConnections({ provider: "xai-oauth" });
  const matching = rows.filter(
    (r: Record<string, unknown>) => r.email === "upsert-user@example.com"
  );
  assert.equal(matching.length, 1);
  assert.equal(matching[0].accessToken, "second-access");
});

test("upstream exchange failure propagates as a thrown error (not swallowed, not returned as a value)", async () => {
  const before = await providersDb.getProviderConnections({ provider: "xai-oauth" });

  globalThis.fetch = async () =>
    new Response("upstream secret leak: token=abc123", { status: 500 });

  await assert.rejects(
    () =>
      exchangeAndPersistConnection("xai-oauth", {
        code: "auth-code",
        redirectUri: "http://127.0.0.1:56121/callback",
        codeVerifier: "verifier",
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      // The extracted function itself does NOT sanitize — that remains the
      // route's outer-catch responsibility (the generic-500 catch stays
      // where it is today). This raw upstream detail
      // propagating out of the function (rather than being swallowed into a
      // falsy/undefined return) is exactly what proves the route's existing
      // try/catch is still the thing turning it into a sanitized 500.
      assert.match((err as Error).message, /xAI token exchange failed/);
      return true;
    }
  );

  // No new connection should have been persisted for a failed exchange.
  const after = await providersDb.getProviderConnections({ provider: "xai-oauth" });
  assert.equal(after.length, before.length);
});
