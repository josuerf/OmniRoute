// Capture point: BaseExecutor.execute() hands claude response headers to the quota recorder.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-claude-hq-"));

import test from "node:test";
import assert from "node:assert/strict";
import { DefaultExecutor } from "../../open-sse/executors/default.ts";
import {
  getClaudeHeaderQuota,
  clearClaudeHeaderQuota,
} from "../../src/lib/quota/claudeHeaderQuota.ts";

const RESET = String(Math.floor(Date.now() / 1000) + 3600);

async function run(connectionId: string, providerSpecificData: Record<string, unknown>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    if (!String(input).includes("/v1/messages")) return new Response("{}", { status: 200 });
    return new Response(JSON.stringify({ id: "msg_1", type: "message", content: [] }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "anthropic-ratelimit-unified-5h-utilization": "0.4",
        "anthropic-ratelimit-unified-5h-reset": RESET,
        "anthropic-ratelimit-unified-5h-status": "allowed",
      },
    });
  }) as typeof fetch;
  try {
    return await new DefaultExecutor("claude").execute({
      model: "claude-opus-4-8",
      body: { model: "claude-opus-4-8", messages: [{ role: "user", content: "hi" }], max_tokens: 8 },
      stream: false,
      credentials: { connectionId, accessToken: "sk-ant-oat01-TESTE", providerSpecificData },
      clientHeaders: { "user-agent": "Cursor/1.0" },
      skipUpstreamRetry: true,
    });
  } finally {
    globalThis.fetch = original;
  }
}

test("setup_token claude response records quota without consuming the body", async () => {
  clearClaudeHeaderQuota();
  const r = await run("conn-st", { authMethod: "setup_token", scopes: ["user:inference"] });
  assert.equal(r.response.status, 200);
  assert.equal(((await r.response.json()) as { id: string }).id, "msg_1");
  assert.equal(getClaudeHeaderQuota("conn-st")!.fiveHour!.utilization, 40);
});

test("OAuth claude response leaves the store untouched", async () => {
  clearClaudeHeaderQuota();
  await run("conn-oauth", { scopes: ["user:inference", "user:profile"] });
  await run("conn-noscopes", {});
  assert.equal(getClaudeHeaderQuota("conn-oauth"), null);
  assert.equal(getClaudeHeaderQuota("conn-noscopes"), null);
});
