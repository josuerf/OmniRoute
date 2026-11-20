/**
 * Operator-level override of the upstream used by the `claude` provider.
 *
 * `CLAUDE_UPSTREAM_BASE_URL` is an origin (like the Anthropic SDK's base URL, e.g.
 * `http://127.0.0.1:21800`); `/v1/messages` is appended. Unset or invalid keeps the registry
 * default. It is env-only on purpose: a per-connection base URL would be settable through the
 * API and open an SSRF/token-exfiltration path.
 */
export function resolveClaudeMessagesBaseUrl(defaultUrl: string): string {
  const raw = process.env.CLAUDE_UPSTREAM_BASE_URL?.trim();
  if (!raw) return defaultUrl;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return defaultUrl;
    const origin = `${parsed.protocol}//${parsed.host}`;
    const path = parsed.pathname.replace(/\/+$/, "").replace(/\/v1\/messages$/, "");
    return `${origin}${path}/v1/messages`;
  } catch {
    return defaultUrl;
  }
}
