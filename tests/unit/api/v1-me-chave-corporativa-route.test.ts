import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

fs.mkdirSync("/data/OmniRoute/_artifacts", { recursive: true });
const TEST_DATA_DIR = fs.mkdtempSync("/data/OmniRoute/_artifacts/chave-corp-");
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "chave-corp-test-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
// Central falso: o fetch abaixo e simulado, nenhuma conexao real sai.
const CENTRAL = "http://127.0.0.1:9";
process.env.ESTEIRA_CENTRAL_URL = CENTRAL;

const core = await import("../../../src/lib/db/core.ts");
const apiKeysDb = await import("../../../src/lib/db/apiKeys.ts");
const compliance = await import("../../../src/lib/compliance/index.ts");
const route = await import("../../../src/app/api/v1/me/chave-corporativa/route.ts");
const { classifyRoute } = await import("../../../src/server/authz/classify.ts");

const originalFetch = globalThis.fetch;
const TOKEN = "tok-falso-sessao-123";
const EMAIL = "fulano.da-silva@exemplo.test";
const NOME = "fulano-da-silva";

type CentralMode = "ok" | "401" | "500" | "throw" | "lixo";
let centralEmail = EMAIL;
let mode: CentralMode = "ok";
let centralCalls: Array<{ url: string; auth: string | null }> = [];

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (!url.startsWith(CENTRAL)) return originalFetch(input, init);
  centralCalls.push({ url, auth: new Headers(init?.headers).get("authorization") });
  if (mode === "throw") throw new Error("rede caiu segredo-upstream");
  if (mode === "401") return new Response("segredo-upstream", { status: 401 });
  if (mode === "500") return new Response("segredo-upstream", { status: 500 });
  if (mode === "lixo") return Response.json({ x: 1 });
  return Response.json({
    email: centralEmail,
    validaAte: "2030-01-01T00:00:00Z",
    nome: "Fulano",
    papel: "dev",
  });
}) as typeof fetch;

function post(
  body: unknown,
  opts: { token?: string | null; raw?: string; headers?: Record<string, string> } = {}
) {
  const headers: Record<string, string> = { "content-type": "application/json", ...opts.headers };
  const tok = opts.token === undefined ? TOKEN : opts.token;
  if (tok) headers.authorization = `Bearer ${tok}`;
  return route.POST(
    new Request("http://localhost/api/v1/me/chave-corporativa", {
      method: "POST",
      headers,
      body: opts.raw ?? JSON.stringify(body),
    })
  );
}

function reset() {
  mode = "ok";
  centralEmail = EMAIL;
  centralCalls = [];
  route.ipLimiter.reset();
  route.tokenLimiter.reset();
  route.globalLimiter.reset();
  route.emailLimiter.reset();
  process.env.ESTEIRA_CENTRAL_URL = CENTRAL;
  core.getDbInstance().prepare("DELETE FROM api_keys").run();
  compliance.getAuditLog({ limit: 1 });
  core.getDbInstance().prepare("DELETE FROM audit_log").run();
  apiKeysDb.clearApiKeyCaches();
}

async function expectErr(res: Response, status: number, code: string) {
  assert.equal(res.status, status);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const text = await res.text();
  assert.ok(!text.includes("segredo-upstream"), "no upstream body");
  assert.ok(!text.includes(TOKEN), "no token");
  assert.equal(JSON.parse(text).error.code, code);
}

test.after(() => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("sem Bearer: 401 sessao_invalida sem chamar o central", async () => {
  reset();
  await expectErr(await post({ email: EMAIL }, { token: null }), 401, "sessao_invalida");
  assert.equal(centralCalls.length, 0);
});

test("central sem URL configurada: 503 central_indisponivel", async () => {
  reset();
  delete process.env.ESTEIRA_CENTRAL_URL;
  await expectErr(await post({ email: EMAIL }), 503, "central_indisponivel");
});

test("401 do central -> 401 sessao_invalida; repassa o mesmo Bearer", async () => {
  reset();
  mode = "401";
  await expectErr(await post({ email: EMAIL }), 401, "sessao_invalida");
  assert.equal(centralCalls[0].auth, `Bearer ${TOKEN}`);
  assert.equal(centralCalls[0].url, `${CENTRAL}/api/sessao/desktop/conferir`);
});

for (const m of ["500", "throw", "lixo"] as const) {
  test(`central ${m} -> 503 central_indisponivel`, async () => {
    reset();
    mode = m;
    await expectErr(await post({ email: EMAIL }), 503, "central_indisponivel");
  });
}

test("e-mail divergente -> 403; caixa diferente nao diverge", async () => {
  reset();
  await expectErr(await post({ email: "outro@exemplo.test" }), 403, "email_divergente");
  await expectErr(await post({ email: EMAIL.toUpperCase() }), 404, "chave_inexistente");
});

test("corpo invalido -> 400; corpo grande -> 413", async () => {
  reset();
  await expectErr(await post({ email: 5 }), 400, "corpo_invalido");
  await expectErr(await post(null, { raw: "{nao json" }), 400, "corpo_invalido");
  await expectErr(await post({ email: EMAIL, extra: 1 }), 400, "corpo_invalido");
  await expectErr(
    await post(null, { raw: JSON.stringify({ email: "a".repeat(5000) }) }),
    413,
    "corpo_grande"
  );
});

test("chave inexistente -> 404 e nao cria", async () => {
  reset();
  await expectErr(await post({ email: EMAIL }), 404, "chave_inexistente");
  assert.equal(apiKeysDb.getApiKeyByName(NOME), null);
});

test("chave inativa, revogada, banida e vencida -> 409 chave_indisponivel", async () => {
  for (const sql of [
    "UPDATE api_keys SET is_active = 0",
    "UPDATE api_keys SET revoked_at = '2020-01-01T00:00:00Z'",
    "UPDATE api_keys SET is_banned = 1",
    "UPDATE api_keys SET expires_at = '2020-01-01T00:00:00Z'",
  ]) {
    reset();
    await apiKeysDb.createApiKey(NOME, "0123456789abcdef");
    core.getDbInstance().prepare(sql).run();
    await expectErr(await post({ email: EMAIL }), 409, "chave_indisponivel");
  }
});

test("chave em texto -> 200 com a chave, rotacionada=false, no-store", async () => {
  reset();
  const created = await apiKeysDb.createApiKey(NOME, "0123456789abcdef");
  const res = await post({ email: EMAIL });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(await res.json(), { nome: NOME, chave: created.key, rotacionada: false });
  const res2 = await post({ email: EMAIL, rotacionar: true });
  assert.equal((await res2.json()).rotacionada, false);
});

test("so hash: 409 sem rotacionar; com rotacionar mesmo id e chave antiga invalida", async () => {
  reset();
  const created = await apiKeysDb.createApiKey(NOME, "0123456789abcdef", ["self:usage"]);
  core.getDbInstance().prepare("UPDATE api_keys SET key = key_hash WHERE id = ?").run(created.id);
  assert.equal(apiKeysDb.getApiKeyByName(NOME)?.storedAsHashOnly, true);
  await expectErr(await post({ email: EMAIL }), 409, "chave_so_hash");
  await expectErr(await post({ email: EMAIL, rotacionar: false }), 409, "chave_so_hash");

  const res = await post({ email: EMAIL, rotacionar: true });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = await res.json();
  assert.equal(body.nome, NOME);
  assert.equal(body.rotacionada, true);
  assert.match(body.chave, /^sk-/);
  assert.notEqual(body.chave, created.key);
  assert.equal(await apiKeysDb.validateApiKey(created.key), false);
  assert.equal(await apiKeysDb.validateApiKey(body.chave), true);
  const after = apiKeysDb.getApiKeyByName(NOME);
  assert.equal(after?.id, created.id);
  assert.equal(after?.storedAsHashOnly, false);
  const meta = await apiKeysDb.getApiKeyById(created.id);
  assert.deepEqual(meta?.scopes, ["self:usage"]);
});

test("rate limit por IP e por e-mail -> 429 no-store", async () => {
  reset();
  for (let i = 0; i < 20; i++) await post({ email: EMAIL });
  await expectErr(await post({ email: EMAIL }), 429, "muitas_tentativas");

  reset();
  let last: Response | null = null;
  for (let i = 0; i < 11; i++) last = await post({ email: EMAIL });
  await expectErr(last!, 429, "muitas_tentativas");
  assert.ok(last!.headers.get("retry-after"));
});

test("auditoria registra quem/nome/rotacao; token e chave nunca aparecem em auditoria nem logs", async () => {
  reset();
  const created = await apiKeysDb.createApiKey(NOME, "0123456789abcdef");
  core.getDbInstance().prepare("UPDATE api_keys SET key = key_hash WHERE id = ?").run(created.id);
  const captured: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: unknown }).write = (c: unknown, ...a: unknown[]) => (
    captured.push(String(c)),
    (origOut as (...x: unknown[]) => boolean)(c, ...a)
  );
  (process.stderr as unknown as { write: unknown }).write = (c: unknown, ...a: unknown[]) => (
    captured.push(String(c)),
    (origErr as (...x: unknown[]) => boolean)(c, ...a)
  );
  let body: { chave: string };
  try {
    body = await (await post({ email: EMAIL, rotacionar: true })).json();
  } finally {
    (process.stdout as unknown as { write: unknown }).write = origOut;
    (process.stderr as unknown as { write: unknown }).write = origErr;
  }
  const events = compliance.getAuditLog({ action: "apiKey.corporateFetch" });
  assert.equal(events.length, 1);
  assert.equal(events[0].actor, EMAIL);
  const serialized = JSON.stringify(events[0]);
  assert.ok(serialized.includes(NOME) && serialized.includes("rotated"));
  for (const e of compliance.getAuditLog({ limit: 100 })) {
    const s = JSON.stringify(e);
    assert.ok(!s.includes(TOKEN) && !s.includes(body.chave));
  }
  const logs = captured.join("");
  assert.ok(!logs.includes(TOKEN) && !logs.includes(body.chave));
});

test("authz: PUBLIC (token do central, nao API key); vizinhas seguem CLIENT_API", () => {
  assert.equal(classifyRoute("/api/v1/me/chave-corporativa", "POST").routeClass, "PUBLIC");
  assert.equal(classifyRoute("/api/v1/me/status", "GET").routeClass, "CLIENT_API");
  assert.equal(classifyRoute("/api/v1/me/chave-corporativa/x", "POST").routeClass, "CLIENT_API");
});

test("A1: XFF rotativo com o mesmo token -> 429 antes de chamar o central", async () => {
  reset();
  let last: Response | null = null;
  for (let i = 0; i < 12; i++) {
    last = await post({ email: EMAIL }, { headers: { "x-forwarded-for": `10.0.0.${i + 1}` } });
  }
  await expectErr(last!, 429, "muitas_tentativas");
  assert.ok(centralCalls.length <= 10);
});

test("A1: muitos tokens distintos batem no teto global ao central", async () => {
  reset();
  let last: Response | null = null;
  for (let i = 0; i < 130; i++) {
    last = await post(
      { email: EMAIL },
      { token: `tok-${i}`, headers: { "x-forwarded-for": `10.1.${i % 250}.1` } }
    );
  }
  await expectErr(last!, 429, "muitas_tentativas");
  assert.ok(centralCalls.length <= 120);
});

test("A2: duas rotacoes concorrentes recebem a MESMA chave, que valida", async () => {
  reset();
  const created = await apiKeysDb.createApiKey(NOME, "0123456789abcdef");
  core.getDbInstance().prepare("UPDATE api_keys SET key = key_hash WHERE id = ?").run(created.id);
  const [a, b] = await Promise.all([
    post({ email: EMAIL, rotacionar: true }),
    post({ email: EMAIL, rotacionar: true }),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const ja = await a.json();
  const jb = await b.json();
  assert.equal(ja.chave, jb.chave);
  assert.equal(await apiKeysDb.validateApiKey(ja.chave), true);
});

test("A3: corpo em stream sem Content-Length acima de 4 KiB -> 413", async () => {
  reset();
  const chunk = new TextEncoder().encode("x".repeat(1024));
  let sent = 0;
  const stream = new ReadableStream({
    pull(ctrl) {
      if (sent++ >= 50) return ctrl.close();
      ctrl.enqueue(chunk);
    },
  });
  const res = await route.POST(
    new Request("http://localhost/api/v1/me/chave-corporativa", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: stream,
      duplex: "half",
    } as RequestInit)
  );
  await expectErr(res, 413, "corpo_grande");
  assert.ok(sent < 50, "aborta a leitura cedo");
});

test("A4: 500 loga a falha sem token", async () => {
  reset();
  await apiKeysDb.createApiKey(NOME, "0123456789abcdef");
  const captured: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: unknown }).write = (c: unknown, ...a: unknown[]) => (
    captured.push(String(c)),
    (origOut as (...x: unknown[]) => boolean)(c, ...a)
  );
  (process.stderr as unknown as { write: unknown }).write = (c: unknown, ...a: unknown[]) => (
    captured.push(String(c)),
    (origErr as (...x: unknown[]) => boolean)(c, ...a)
  );
  core.getDbInstance().prepare("ALTER TABLE api_keys RENAME TO api_keys_x").run();
  try {
    await expectErr(await post({ email: EMAIL }), 500, "erro_interno");
  } finally {
    core.getDbInstance().prepare("ALTER TABLE api_keys_x RENAME TO api_keys").run();
    (process.stdout as unknown as { write: unknown }).write = origOut;
    (process.stderr as unknown as { write: unknown }).write = origErr;
  }
  const logs = captured.join("");
  assert.ok(!logs.includes(TOKEN));
});

test("A5: getApiKeyByName prefere a linha ativa e nao revogada", async () => {
  reset();
  const old = await apiKeysDb.createApiKey(NOME, "0123456789abcdef");
  core
    .getDbInstance()
    .prepare(
      "UPDATE api_keys SET revoked_at = '2020-01-01T00:00:00Z', is_active = 0, created_at = '2020-01-01T00:00:00Z' WHERE id = ?"
    )
    .run(old.id);
  const fresh = await apiKeysDb.createApiKey(NOME, "0123456789abcdef");
  assert.equal(apiKeysDb.getApiKeyByName(NOME)?.id, fresh.id);
});

for (const [nome, email] of [
  ["Kelvin", "Kelvin@exemplo.test"],
  ["sem @", "semarroba"],
  ["local vazia", "@exemplo.test"],
  ["dois @", "a@b@exemplo.test"],
  ["dominio vazio", "fulano@"],
] as const) {
  test(`S1: e-mail do central invalido (${nome}) -> 503 central_indisponivel`, async () => {
    reset();
    centralEmail = email;
    await expectErr(await post({ email }), 503, "central_indisponivel");
  });
}

for (const url of [
  "http://127.0.0.2:9",
  "https://127.0.0.1:9/?x=1",
  "https://127.0.0.1:9/#h",
  "https://user:pw@127.0.0.1:9",
]) {
  test(`S2: ESTEIRA_CENTRAL_URL invalida (${url}) -> 503 sem chamar`, async () => {
    reset();
    process.env.ESTEIRA_CENTRAL_URL = url;
    await expectErr(await post({ email: EMAIL }), 503, "central_indisponivel");
    assert.equal(centralCalls.length, 0);
  });
}
