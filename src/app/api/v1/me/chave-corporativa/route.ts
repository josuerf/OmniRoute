import { z } from "zod";

import { errorResponse } from "@omniroute/open-sse/utils/error";
import { getClientIpFromRequest } from "@/lib/ipUtils";
import { conferirSessaoDesktop, nomeDaChavePorEmail } from "@/lib/corp/esteiraCentral";
import { createAttemptLimiter } from "@/lib/corp/tentativasLimiter";

const MAX_BODY_BYTES = 4096;
const LIMIT_PER_IP = 20;
const LIMIT_PER_EMAIL = 10;
const WINDOW_MS = 60_000;

// Exported for tests.
export const ipLimiter = createAttemptLimiter(LIMIT_PER_IP, WINDOW_MS);
export const emailLimiter = createAttemptLimiter(LIMIT_PER_EMAIL, WINDOW_MS);

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
  const text = await request.text();
  return Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES ? null : text;
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
      const result = await regenerateApiKey(found.id);
      if (!result) return fail(404, "chave_inexistente", "Key not found");
      chave = result.key;
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
  } catch {
    return fail(500, "erro_interno", "Internal error");
  }
}
