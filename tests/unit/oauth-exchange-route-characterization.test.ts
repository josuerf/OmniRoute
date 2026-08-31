// Characterization test for the `exchange` action of
// `src/app/api/oauth/[provider]/[action]/route.ts`, written BEFORE extracting
// the exchange-and-persist logic into `src/lib/oauth/exchangeAndPersistConnection.ts`
// (a behavior-preserving refactor).
//
// The existing `tests/unit/oauth-grok-cli-browser.test.ts` already covers the
// missing-codeVerifier 400 and the sanitized-500-on-upstream-failure cases for
// the exchange action (for the grok-cli provider), but nothing in the suite
// exercised the SUCCESS response shape end-to-end. This file locks that success
// shape down too, using the xai-oauth provider (authorization_code_pkce, no
// secondary bootstrap fetch, so the mocked single `fetch` call is sufficient).
//
// DB handles released in test.after (CLAUDE.md learning: unreleased SQLite
// handles hang node:test).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "omniroute-oauth-exchange-characterization-")
);
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const route = await import("../../src/app/api/oauth/[provider]/[action]/route.ts");

const originalFetch = globalThis.fetch;

test.before(async () => {
  await settingsDb.updateSettings({ requireLogin: false });
});

test.after(async () => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

function postRoute(provider: string, action: string, body: unknown) {
  const request = new Request(`http://localhost:20129/api/oauth/${provider}/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return route.POST(request, { params: Promise.resolve({ provider, action }) });
}

function createJwt(payload: Record<string, unknown>) {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.signature`;
}

test("BASELINE: POST /api/oauth/xai-oauth/exchange succeeds and returns the connection shape", async () => {
  const idToken = createJwt({ email: "baseline-user@example.com", name: "Baseline User" });
  globalThis.fetch = async () =>
    Response.json({
      access_token: "baseline-access",
      refresh_token: "baseline-refresh",
      id_token: idToken,
      expires_in: 3600,
    });

  const res = await postRoute("xai-oauth", "exchange", {
    code: "auth-code",
    redirectUri: "http://127.0.0.1:56121/callback",
    codeVerifier: "verifier",
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(typeof body.connection.id, "string");
  assert.equal(body.connection.provider, "xai-oauth");
  assert.equal(body.connection.email, "baseline-user@example.com");
  // Snapshot whatever the current behavior produces for displayName, so a
  // regression in the refactor is caught even though this field is not
  // populated by xaiOauth.mapTokens today. JSON.stringify (via NextResponse.json)
  // drops object keys whose value is `undefined`, so the key itself is absent
  // from the serialized body.
  assert.equal(body.connection.displayName, undefined);
  assert.equal(Object.keys(body.connection).sort().join(","), "email,id,provider");
});

test("BASELINE: POST /api/oauth/xai-oauth/exchange requires a codeVerifier (PKCE branch reached)", async () => {
  const res = await postRoute("xai-oauth", "exchange", {
    code: "auth-code",
    redirectUri: "http://127.0.0.1:56121/callback",
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error.details[0].message, /Code verifier is required for xai-oauth/);
});

test("BASELINE: POST /api/oauth/xai-oauth/exchange failure returns a sanitized 500", async () => {
  globalThis.fetch = async () =>
    new Response("upstream secret leak: token=abc123", { status: 500 });

  const res = await postRoute("xai-oauth", "exchange", {
    code: "auth-code",
    redirectUri: "http://127.0.0.1:56121/callback",
    codeVerifier: "verifier",
  });
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.doesNotMatch(String(body.error), /token=abc123/, "must not leak the upstream error body");
  assert.doesNotMatch(String(body.error), /at \//, "must not leak a stack trace");
});
