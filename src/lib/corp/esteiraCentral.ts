import { z } from "zod";

/**
 * Client for the esteira central: confirms a desktop session token.
 * Contract: GET <ESTEIRA_CENTRAL_URL>/api/sessao/desktop/conferir (IAF-919).
 * TLS is always verified (extra CAs only via NODE_EXTRA_CA_CERTS).
 */

export const CENTRAL_TIMEOUT_MS = 5000;

/** Exactly one `@`, ASCII local part, non-empty domain (after NFKC). */
const EMAIL_LOCAL = /^[A-Za-z0-9._-]+$/;
export function emailCorporativoValido(email: string): boolean {
  // Local part must be ASCII BEFORE normalization (NFKC would fold U+212A into "K").
  const parts = email.split("@");
  return parts.length === 2 && EMAIL_LOCAL.test(parts[0]) && parts[1].normalize("NFKC").length > 0;
}

const sessaoSchema = z.object({
  email: z
    .string()
    .min(3)
    .max(320)
    .refine((v) => emailCorporativoValido(v.trim())),
  validaAte: z.string().min(1).max(64),
  nome: z.string().max(256),
  papel: z.string().max(64),
});

export type SessaoDesktopConferida = z.infer<typeof sessaoSchema>;

export type ConferirSessaoResult =
  | { status: "ok"; sessao: SessaoDesktopConferida }
  | { status: "sessao_invalida" }
  | { status: "central_indisponivel" };

function resolveCentralBase(): string | null {
  const raw = (process.env.ESTEIRA_CENTRAL_URL ?? "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.search || url.hash || url.username || url.password) return null;
    if (url.protocol !== "https:") {
      const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
      if (!(url.protocol === "http:" && loopback)) return null;
    }
    return raw.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export async function conferirSessaoDesktop(token: string): Promise<ConferirSessaoResult> {
  const base = resolveCentralBase();
  if (!base) return { status: "central_indisponivel" };

  try {
    const response = await fetch(`${base}/api/sessao/desktop/conferir`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(CENTRAL_TIMEOUT_MS),
      redirect: "error",
      cache: "no-store",
    });
    if (response.status === 401) return { status: "sessao_invalida" };
    if (response.status !== 200) return { status: "central_indisponivel" };
    const parsed = sessaoSchema.safeParse(await response.json());
    if (!parsed.success) return { status: "central_indisponivel" };
    return { status: "ok", sessao: parsed.data };
  } catch {
    return { status: "central_indisponivel" };
  }
}

/** `josue.defreitas@x.com` -> `josue-defreitas`. */
export function nomeDaChavePorEmail(email: string): string {
  const local = email.trim().normalize("NFKC").split("@")[0] ?? "";
  return local.toLowerCase().replace(/\./g, "-");
}
