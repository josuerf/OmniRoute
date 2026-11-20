import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-claude-url-"));

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { DefaultExecutor } from "../../open-sse/executors/default.ts";
import { resolveClaudeMessagesBaseUrl } from "../../open-sse/executors/claudeUpstreamUrl.ts";
import { getRegistryEntry } from "../../open-sse/config/providerRegistry.ts";

const DEFAULT = getRegistryEntry("claude")!.baseUrl as string;
const PORT = 21801;

test("default URL when env is unset or invalid", () => {
  delete process.env.CLAUDE_UPSTREAM_BASE_URL;
  assert.equal(resolveClaudeMessagesBaseUrl(DEFAULT), DEFAULT);
  process.env.CLAUDE_UPSTREAM_BASE_URL = "ftp://x";
  assert.equal(resolveClaudeMessagesBaseUrl(DEFAULT), DEFAULT);
  process.env.CLAUDE_UPSTREAM_BASE_URL = "not a url";
  assert.equal(resolveClaudeMessagesBaseUrl(DEFAULT), DEFAULT);
  delete process.env.CLAUDE_UPSTREAM_BASE_URL;
});

test("env is an origin; /v1/messages is appended once", () => {
  process.env.CLAUDE_UPSTREAM_BASE_URL = `http://127.0.0.1:${PORT}/`;
  assert.equal(resolveClaudeMessagesBaseUrl(DEFAULT), `http://127.0.0.1:${PORT}/v1/messages`);
  process.env.CLAUDE_UPSTREAM_BASE_URL = `http://127.0.0.1:${PORT}/v1/messages`;
  assert.equal(resolveClaudeMessagesBaseUrl(DEFAULT), `http://127.0.0.1:${PORT}/v1/messages`);
  delete process.env.CLAUDE_UPSTREAM_BASE_URL;
});

test("claude executor builds the stub URL; psd.baseUrl does not redirect claude", () => {
  const ex = new DefaultExecutor("claude");
  delete process.env.CLAUDE_UPSTREAM_BASE_URL;
  assert.equal(ex.buildUrl("m", false, 0, null), `${DEFAULT}?beta=true`);
  const creds = { providerSpecificData: { baseUrl: "http://169.254.169.254" } };
  assert.equal(ex.buildUrl("m", false, 0, creds as never), `${DEFAULT}?beta=true`);
  process.env.CLAUDE_UPSTREAM_BASE_URL = `http://127.0.0.1:${PORT}`;
  assert.equal(
    ex.buildUrl("m", false, 0, creds as never),
    `http://127.0.0.1:${PORT}/v1/messages?beta=true`
  );
  // other providers sharing the "claude" branch are untouched
  assert.equal(
    new DefaultExecutor("glm").buildUrl("m", false, 0, null).startsWith("http://127.0.0.1"),
    false
  );
  delete process.env.CLAUDE_UPSTREAM_BASE_URL;
});

test("executor.execute really calls the local stub", async () => {
  const seen: Array<{ url: string; auth: string | undefined }> = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url ?? "", auth: req.headers.authorization });
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "msg_stub", type: "message", content: [] }));
  });
  await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));
  process.env.CLAUDE_UPSTREAM_BASE_URL = `http://127.0.0.1:${PORT}`;
  try {
    const r = await new DefaultExecutor("claude").execute({
      model: "claude-haiku-4-5-20251001",
      body: {
        model: "claude-haiku-4-5-20251001",
        messages: [{ role: "user", content: "." }],
        max_tokens: 1,
      },
      stream: false,
      credentials: {
        connectionId: "c1",
        accessToken: "sk-ant-oat01-TESTE",
        providerSpecificData: { authMethod: "setup_token", scopes: ["user:inference"] },
      },
      clientHeaders: {},
      skipUpstreamRetry: true,
    });
    assert.equal(r.response.status, 200);
    assert.equal(seen.length, 1);
    assert.match(seen[0].url, /^\/v1\/messages\?beta=true$/);
    assert.equal(seen[0].auth, "Bearer sk-ant-oat01-TESTE");
  } finally {
    delete process.env.CLAUDE_UPSTREAM_BASE_URL;
    await new Promise((r) => server.close(r));
  }
});
