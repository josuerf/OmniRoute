import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-claude-probe-"));

import test from "node:test";
import assert from "node:assert/strict";
import {
  getClaudeProbeModel,
  getClaudeSetupTokenProbeIntervalMs,
  isClaudeSetupTokenProbeDue,
  probeClaudeSetupTokenConnection,
  probeDueClaudeSetupTokenConnections,
} from "../../src/lib/oauth/utils/claudeSetupTokenProbe.ts";

// Fictitious token, assembled at runtime so no secret-looking literal sits in the source.
const TOKEN = ["sk", "ant", "oat01", "TESTEabcdefghijklmnopqrstuvwxyz"].join("-");
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);

const conn = (extra: Record<string, unknown> = {}, psd: Record<string, unknown> = {}) => ({
  id: "c1",
  provider: "claude",
  isActive: true,
  accessToken: TOKEN,
  providerSpecificData: {
    authMethod: "setup_token",
    scopes: ["user:inference"],
    ownerKeyId: "k1",
    ...psd,
  },
  ...extra,
});

function harness(respond: () => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const logs: string[] = [];
  const updates: Array<Record<string, unknown>> = [];
  const revoked: string[] = [];
  const recorded: Array<{ id: unknown; headers: unknown }> = [];
  const deps = {
    now: () => NOW,
    log: (m: string) => logs.push(m),
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return respond();
    }) as unknown as typeof fetch,
    markRevoked: async (id: string) => {
      revoked.push(id);
    },
    getConnection: async () => conn() as Record<string, unknown>,
    updateConnection: async (_id: string, patch: Record<string, unknown>) => {
      updates.push(patch);
    },
    recordQuota: ((id: unknown, headers: unknown) => {
      recorded.push({ id, headers });
      return null;
    }) as never,
  };
  return { deps, calls, logs, updates, revoked, recorded };
}

test("interval: default 24h, numbers, and off switches", () => {
  assert.equal(getClaudeSetupTokenProbeIntervalMs({}), 24 * HOUR);
  assert.equal(
    getClaudeSetupTokenProbeIntervalMs({ CLAUDE_SETUP_TOKEN_PROBE_INTERVAL_HOURS: "6" }),
    6 * HOUR
  );
  for (const v of ["0", "false", "off", "OFF"]) {
    assert.equal(
      getClaudeSetupTokenProbeIntervalMs({ CLAUDE_SETUP_TOKEN_PROBE_INTERVAL_HOURS: v }),
      null
    );
  }
  assert.equal(
    getClaudeSetupTokenProbeIntervalMs({ CLAUDE_SETUP_TOKEN_PROBE_INTERVAL_HOURS: "junk" }),
    24 * HOUR
  );
});

test("probe model is the smallest claude model (haiku)", () => {
  assert.match(getClaudeProbeModel(), /haiku/);
});

test("due rules: setup_token only, active, not revoked, interval elapsed", () => {
  assert.equal(isClaudeSetupTokenProbeDue(conn(), NOW, 24 * HOUR), true);
  const old = new Date(NOW - 25 * HOUR).toISOString();
  const recent = new Date(NOW - 2 * HOUR).toISOString();
  assert.equal(isClaudeSetupTokenProbeDue(conn({}, { lastProbeAt: old }), NOW, 24 * HOUR), true);
  assert.equal(
    isClaudeSetupTokenProbeDue(conn({}, { lastProbeAt: recent }), NOW, 24 * HOUR),
    false
  );
  assert.equal(isClaudeSetupTokenProbeDue(conn({ isActive: false }), NOW, 24 * HOUR), false);
  assert.equal(
    isClaudeSetupTokenProbeDue(conn({ lastErrorType: "token_revoked" }), NOW, 24 * HOUR),
    false
  );
  assert.equal(isClaudeSetupTokenProbeDue(conn({ testStatus: "expired" }), NOW, 24 * HOUR), false);
  assert.equal(isClaudeSetupTokenProbeDue(conn({ accessToken: null }), NOW, 24 * HOUR), false);
  assert.equal(
    isClaudeSetupTokenProbeDue(conn({}, { authMethod: undefined }), NOW, 24 * HOUR),
    false
  );
  assert.equal(isClaudeSetupTokenProbeDue(conn({ provider: "openai" }), NOW, 24 * HOUR), false);
});

test("request: POST /v1/messages, bearer + anthropic-version + oauth beta, max_tokens 1", async () => {
  const h = harness(() => new Response("{}", { status: 200 }));
  await probeClaudeSetupTokenConnection(conn(), h.deps);
  assert.equal(h.calls.length, 1);
  const { url, init } = h.calls[0];
  assert.match(url, /\/v1\/messages/);
  assert.equal(init.method, "POST");
  const headers = init.headers as Record<string, string>;
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  assert.equal(lower["authorization"], `Bearer ${TOKEN}`);
  assert.ok(lower["anthropic-version"]);
  assert.match(lower["anthropic-beta"] ?? "", /oauth/);
  assert.equal(lower["x-api-key"], undefined);
  const body = JSON.parse(String(init.body));
  assert.equal(body.max_tokens, 1);
  assert.match(body.model, /haiku/);
  assert.deepEqual(body.messages, [{ role: "user", content: "." }]);
  assert.ok(init.signal);
});

test("401 marks token_revoked and stamps lastProbeAt", async () => {
  const h = harness(() => new Response("{}", { status: 401 }));
  assert.equal(await probeClaudeSetupTokenConnection(conn(), h.deps), "revoked");
  assert.deepEqual(h.revoked, ["c1"]);
  const psd = h.updates.at(-1)!.providerSpecificData as Record<string, unknown>;
  assert.equal(psd.lastProbeAt, new Date(NOW).toISOString());
  assert.equal(psd.lastProbeStatus, 401);
});

test("2xx records quota from the response headers and clears a stale error", async () => {
  const h = harness(
    () =>
      new Response("{}", {
        status: 200,
        headers: { "anthropic-ratelimit-unified-5h-utilization": "0.4" },
      })
  );
  const outcome = await probeClaudeSetupTokenConnection(
    conn({ lastErrorType: "rate_limit", lastError: "x", testStatus: "error" }),
    h.deps
  );
  assert.equal(outcome, "ok");
  assert.equal(h.recorded.length, 1);
  assert.equal(h.recorded[0].id, "c1");
  assert.equal(
    (h.recorded[0].headers as Headers).get("anthropic-ratelimit-unified-5h-utilization"),
    "0.4"
  );
  assert.equal(h.updates.at(-1)!.lastErrorType, null);
  assert.equal(h.updates.at(-1)!.testStatus, "active");
  assert.deepEqual(h.revoked, []);
});

for (const status of [429, 500, 503, 400, 403]) {
  test(`status ${status} never revokes and does not stamp lastProbeAt`, async () => {
    const h = harness(() => new Response("{}", { status }));
    assert.equal(await probeClaudeSetupTokenConnection(conn(), h.deps), "transient");
    assert.deepEqual(h.revoked, []);
    assert.equal(h.updates.length, 0);
    assert.equal(h.recorded.length, 0);
    assert.equal(h.logs.join("\n").includes(TOKEN), false);
  });
}

test("network error and timeout never revoke and never log the token", async () => {
  const boom = harness(() => {
    throw new Error(`connect ECONNREFUSED with ${TOKEN}`);
  });
  assert.equal(await probeClaudeSetupTokenConnection(conn(), boom.deps), "transient");
  assert.deepEqual(boom.revoked, []);
  assert.equal(boom.logs.join("\n").includes(TOKEN), false);

  const slow = harness(() => new Response("{}"));
  const t = await probeClaudeSetupTokenConnection(conn(), {
    ...slow.deps,
    timeoutMs: 20,
    fetch: ((_u: string, init: RequestInit) =>
      new Promise((_r, rej) => {
        init.signal!.addEventListener("abort", () => rej(init.signal!.reason));
      })) as unknown as typeof fetch,
  });
  assert.equal(t, "transient");
  assert.deepEqual(slow.revoked, []);
});

test("sweep: disabled (0) makes no call; due ones are probed serially, skipping revoked/recent", async () => {
  const recent = new Date(NOW - HOUR).toISOString();
  const list = async () => [
    conn({ id: "a" }),
    conn({ id: "b", lastErrorType: "token_revoked" }),
    conn({ id: "c" }, { lastProbeAt: recent }),
    conn({ id: "d" }),
  ];
  const off = harness(() => new Response("{}", { status: 200 }));
  const r0 = await probeDueClaudeSetupTokenConnections({
    ...off.deps,
    listConnections: list,
    env: { CLAUDE_SETUP_TOKEN_PROBE_INTERVAL_HOURS: "0" },
  });
  assert.deepEqual(r0, { probed: 0, disabled: true });
  assert.equal(off.calls.length, 0);

  const on = harness(() => new Response("{}", { status: 200 }));
  const r1 = await probeDueClaudeSetupTokenConnections({
    ...on.deps,
    listConnections: list,
    env: {},
  });
  assert.deepEqual(r1, { probed: 2, disabled: false });
  assert.equal(on.calls.length, 2);
});

test("401 for a token that was replaced during the probe does not revoke the new token", async () => {
  const h = harness(() => new Response("{}", { status: 401 }));
  const NEW_TOKEN = [...TOKEN.split("-").slice(0, 3), "TESTEnovotokenzyxwvutsrqponmlkji"].join("-");
  let swapped = false;
  const fetchStub = h.deps.fetch;
  h.deps.fetch = (async (url: string, init: RequestInit) => {
    const res = await (fetchStub as unknown as (u: string, i: RequestInit) => Promise<Response>)(
      url,
      init
    );
    swapped = true; // the user re-links while the request is in flight
    return res;
  }) as unknown as typeof fetch;
  h.deps.getConnection = async () =>
    conn(swapped ? { accessToken: NEW_TOKEN } : {}) as Record<string, unknown>;

  const outcome = await probeClaudeSetupTokenConnection(conn() as never, h.deps as never);
  assert.equal(outcome, "transient");
  assert.deepEqual(h.revoked, []);
  assert.deepEqual(h.updates, [], "nothing written for a stale probe result");
  assert.deepEqual(h.recorded, []);
  assert.ok(!h.logs.join("\n").includes(NEW_TOKEN) && !h.logs.join("\n").includes(TOKEN));
});

test("a connection deleted during the probe is left alone", async () => {
  const h = harness(() => new Response("{}", { status: 401 }));
  h.deps.getConnection = async () => null;
  const outcome = await probeClaudeSetupTokenConnection(conn() as never, h.deps as never);
  assert.equal(outcome, "transient");
  assert.deepEqual(h.revoked, []);
  assert.deepEqual(h.updates, []);
});

test("a blocked proxy assignment skips the probe (no direct egress)", async () => {
  const h = harness(() => new Response("{}", { status: 200 }));
  const deps = { ...h.deps, resolveProxy: async () => ({ proxyConfig: null, blocked: true }) };
  const outcome = await probeClaudeSetupTokenConnection(conn() as never, deps as never);
  assert.equal(outcome, "transient");
  assert.equal(h.calls.length, 0);
});
