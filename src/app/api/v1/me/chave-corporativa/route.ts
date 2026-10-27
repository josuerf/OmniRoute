import { createHash } from "node:crypto";
import { z } from "zod";

import { errorResponse } from "@omniroute/open-sse/utils/error";
import { getClientIpFromRequest } from "@/lib/ipUtils";
import { createLogger } from "@/shared/utils/logger";
import { conferirSessaoDesktop, nomeDaChavePorEmail } from "@/lib/corp/esteiraCentral";
import { createAttemptLimiter, createKeyedMutex } from "@/lib/corp/tentativasLimiter";

const MAX_BODY_BYTES = 4096;
const LIMIT_PER_IP = 20;
const LIMIT_PER_EMAIL = 10;
const LIMIT_PER_TOKEN = 10;
const LIMIT_GLOBAL = 120;
const WINDOW_MS = 60_000;
const log = createLogger("chave-corporativa");
const withKeyLock = createKeyedMutex();

// Exported for tests.
export const ipLimiter = createAttemptLimiter(LIMIT_PER_IP, WINDOW_MS);
export const emailLimiter = createAttemptLimiter(LIMIT_PER_EMAIL, WINDOW_MS);
// Not spoofable via headers: keyed by SHA-256 of the Bearer (never the token itself) + a global cap
// on calls to the central.
export const tokenLimiter = createAttemptLimiter(LIMIT_PER_TOKEN, WINDOW_MS);
export const globalLimiter = createAttemptLimiter(LIMIT_GLOBAL, WINDOW_MS);

const bodySchema = z
  .object({
    email: z.string().min(3).max(320),
    rotacionar: z.boolean().optional(),
  })
  .strict();

function fail(status: number, code: string, message: string, retryAfter?: number): Response {
  const res = errorResponse(status, message, { code, type: code });
  const headers = new Headers(res.headers);
  headers.set("Cache-Control", "no-store");
  if (retryAfter) headers.set("Retry-After", String(retryAfter));
  return new Response(res.body, { status, headers });
}

function ok(payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function extractBearer(request: Request): string | null {
  const match = (request.headers.get("authorization") ?? "").match(/^Bearer\s+(\S+)\s*$/i);
  return match?.[1] ?? null;
}

async function readLimitedBody(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function POST(request: Request): Promise<Response> {
  const wait = ipLimiter.hit(getClientIpFromRequest(request));
  if (wait) return fail(429, "muitas_tentativas", "Too many attempts", wait);

  const token = extractBearer(request);
  if (!token) return fail(401, "sessao_invalida", "Invalid session");

  const raw = await readLimitedBody(request);
  if (raw === null) return fail(413, "corpo_grande", "Request body too large");

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return fail(400, "corpo_invalido", "Invalid request body");
  }
  const body = bodySchema.safeParse(parsedJson);
  if (!body.success) return fail(400, "corpo_invalido", "Invalid request body");

  const tokenWait = tokenLimiter.hit(createHash("sha256").update(token).digest("hex"));
  if (tokenWait) return fail(429, "muitas_tentativas", "Too many attempts", tokenWait);
  const globalWait = globalLimiter.hit("central");
  if (globalWait) return fail(429, "muitas_tentativas", "Too many attempts", globalWait);

  const central = await conferirSessaoDesktop(token);
  if (central.status === "sessao_invalida") return fail(401, "sessao_invalida", "Invalid session");
  if (central.status !== "ok") return fail(503, "central_indisponivel", "Central unavailable");

  const centralEmail = central.sessao.email.trim().toLowerCase();
  const emailWait = emailLimiter.hit(centralEmail);
  if (emailWait) return fail(429, "muitas_tentativas", "Too many attempts", emailWait);

  if (body.data.email.trim().toLowerCase() !== centralEmail) {
    return fail(403, "email_divergente", "Email does not match the session");
  }

  try {
    const { getApiKeyByName, regenerateApiKey } = await import("@/lib/db/apiKeys");
    const nome = nomeDaChavePorEmail(centralEmail);
    const found = getApiKeyByName(nome);
    if (!found) return fail(404, "chave_inexistente", "Key not found");

    const expired = found.expiresAt !== null && new Date(found.expiresAt).getTime() <= Date.now();
    if (!found.isActive || found.isBanned || found.revokedAt !== null || expired) {
      return fail(409, "chave_indisponivel", "Key unavailable");
    }

    let chave = found.key;
    let rotacionada = false;
    if (found.storedAsHashOnly || !chave) {
      if (body.data.rotacionar !== true) {
        return fail(409, "chave_so_hash", "Key is stored only as a hash; rotation required");
      }
      const outcome = await withKeyLock(found.id, async () => {
        const current = getApiKeyByName(nome);
        if (!current || current.id !== found.id) return null;
        if (!current.storedAsHashOnly && current.key) return current.key;
        const result = await regenerateApiKey(found.id);
        return result ? result.key : null;
      });
      if (!outcome) return fail(404, "chave_inexistente", "Key not found");
      chave = outcome;
      rotacionada = true;
    }

    const { logAuditEvent } = await import("@/lib/compliance");
    logAuditEvent({
      action: "apiKey.corporateFetch",
      actor: centralEmail,
      target: found.id,
      resourceType: "api_key",
      ipAddress: getClientIpFromRequest(request),
      details: { name: found.name, rotated: rotacionada },
    });

    return ok({ nome: found.name, chave, rotacionada });
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.name : "unknown" },
      "chave-corporativa: erro interno"
    );
    return fail(500, "erro_interno", "Internal error");
  }
}
