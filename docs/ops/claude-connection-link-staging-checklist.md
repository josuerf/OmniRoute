---
title: "Claude Connection Link — Staging Smoke-Test Checklist"
version: 3.8.50
lastUpdated: 2026-08-18
---

# Claude Connection Link — Staging Smoke-Test Checklist

Manual, human-operator checklist for validating the self-service Claude
connection-link feature (`POST /api/v1/me/connections/claude` onboarding)
against a **real** Claude Teams account, a **deployed** OmniRoute instance, and
**VPN network access to Anthropic** — none of which exist in a sandboxed dev
environment.

This complements, not replaces, the automated coverage:

- Unit/DB-level: `tests/unit/db/api-keys-connection-link.test.ts`,
  `tests/unit/t08-allowed-connections.test.ts`,
  `tests/unit/api/v1-me-connections-claude-route.test.ts`.
- Local integration (mocked OAuth exchange, real SQLite, real routing-enforcement
  code): `tests/integration/claude-onboarding-routing.test.ts`. This proves
  the `allowedConnections` invariant against `src/sse/services/auth.ts`'s
  `getProviderCredentials()` and the `src/sse/handlers/chat.ts` request path, but
  **stubs** the Anthropic OAuth token exchange via `globalThis.fetch` — it never
  calls the real Anthropic API.

Nothing below has been executed automatically. Run every step against a real
staging deploy before rolling this feature out to production.

## Prerequisites

- [ ] A deployed OmniRoute staging instance reachable from the operator's machine
      (VPN as required — see `docs/ops/TUNNELS_GUIDE.md` / `docs/ops/VM_DEPLOYMENT_GUIDE.md`
      for how staging/VPS access is normally established in this repo).
- [ ] A real Claude Teams (or Claude Pro/Max) account able to complete the OAuth
      authorization-code + PKCE flow used by `src/lib/oauth/providers/claude.ts`.
- [ ] A real, **non-admin developer** OmniRoute API key with the `self:usage` scope
      (created via the dashboard or `POST /api/keys`), distinct from any
      admin/management key.
- [ ] Claude Code CLI installed locally (`npm i -g @anthropic-ai/claude-code` or
      equivalent), version compatible with gateway model discovery per
      `docs/guides/CLAUDE-CODE-CONFIGURATION.md`.
- [ ] A second, unrelated OmniRoute API key + Claude connection already linked
      (or linked as part of this run) to use as the "wrong connection" negative
      control in the rejection check below.

## 1. Full portal onboarding flow (real account, real key)

- [ ] Sign in to the OmniRoute dashboard (or open the self-service linking
      portal surface) using the non-admin developer API key's owning account.
- [ ] Start the Claude connection flow and complete the real Claude Teams OAuth
      consent screen (authorization-code + PKCE) end to end — do **not** stop at
      the redirect; let the exchange complete.
- [ ] Confirm the UI reports a successful link (`status: "linked"` or
      `"already_linked"`) and shows a connection identifier / account email.

## 2. `allowedConnections` reflects the new connection

- [ ] Call `GET /api/v1/me/status` with the developer key's Bearer token and
      confirm the response's `allowedConnections` (or equivalent field) includes
      the newly created Claude connection's id.
- [ ] If the key had any **pre-existing** allowed connections before this run,
      confirm they are **still present** in the same list (nothing was dropped by
      the link operation) — cross-check against the dashboard's API Manager view
      for the same key.
- [ ] Repeat via the dashboard's key detail / API Manager page and confirm the UI
      agrees with the API response (same connection id, same count).

## 3. A real Claude Code request succeeds through the linked connection

- [ ] Configure Claude Code exactly per
      `docs/guides/CLAUDE-CODE-CONFIGURATION.md` — gateway root URL only, **no
      `/v1` suffix**, using the individual developer API key.
- [ ] `ANTHROPIC_BASE_URL` = the staging gateway root (e.g. `https://<staging-host>`
      or `http://<staging-host>:20128`) — verify there is no trailing `/v1`.
- [ ] `ANTHROPIC_AUTH_TOKEN` = the developer's own OmniRoute API key (sent as
      `Authorization: Bearer …`), or `ANTHROPIC_API_KEY` (sent as `x-api-key`) —
      never an admin/management key.
- [ ] Restart Claude Code after setting these (env is read once at startup).
- [ ] Send a real prompt from Claude Code and confirm a normal, successful
      response (equivalent to a real `/v1/messages` round trip through the
      gateway).
- [ ] In OmniRoute's own request/usage log (Dashboard → Usage, or
      `GET /api/monitoring` / call-log view) confirm the request is attributed to
      the developer key **and** to the newly linked Claude connection id from
      step 1 — not to any other connection.

## 4. A request against an unallowed Claude connection is rejected

- [ ] Using the same developer key, attempt to force routing through the
      **other**, unrelated Claude connection from the Prerequisites (e.g. via
      the `X-OmniRoute-Connection` header, or by temporarily pointing a combo
      target at that connection id, per `src/sse/handlers/chat.ts`'s
      `requestedConnectionId` handling).
- [ ] Confirm the request is **never** served by the unallowed connection — either
      it is rejected outright (expect `401 No active credentials for provider:
claude` for this single-model request if the developer key has no eligible
      Claude connection at all, matching `handleNoCredentials()` in
      `src/sse/handlers/chatHelpers.ts` — 404 is reserved for combo routing's
      internal fall-through signal), or it silently falls back to the developer
      key's own allowed connection. Check the request/usage log's recorded
      connection id to be certain — do not infer success/failure from the HTTP
      status alone.
- [ ] Confirm the response never contains any data, token, or account identifier
      belonging to the unrelated Claude connection's account.

## 5. Security properties hold up under a real end-to-end run

Re-verify — under real traffic, not just unit tests — the security properties
confirmed by the route's own unit tests:

- [ ] Server logs (application logs, not just the DB-backed usage log) do not
      contain the developer's OmniRoute API key in plaintext anywhere in the
      onboarding or chat-request flow (`grep` staging logs for the key value
      after the run, expect zero matches).
- [ ] Server logs do not contain the Claude OAuth access token, refresh token, or
      authorization `code`/`codeVerifier` in plaintext at any point (exchange,
      link, or chat request).
- [ ] The `POST /api/v1/me/connections/claude` response body (captured via
      browser devtools/network tab or an HTTP proxy during step 1) never includes
      the raw access/refresh token — only a connection id and status, per the
      route's documented response shape.
- [ ] The dashboard's connection list/detail view for this Claude connection does
      not render the raw OAuth tokens.
- [ ] Attempting the link flow with a management-only key (no `self:usage` scope)
      is rejected with `403`, confirmed against the real deployed route (not just
      the unit test).
- [ ] Attempting the link flow with an invalid/expired Bearer token is rejected
      with `401`.

## Sign-off

- [ ] Record the OmniRoute version/build (`dashboard/health` or
      `GET /api/monitoring/health`) the checklist was run against.
- [ ] Record the date, operator, and a link to any captured evidence (screenshots,
      HAR file, or log excerpts) for steps 3-5.
- [ ] File any failures as a blocking issue before this feature is enabled for
      the general developer population — do not treat a partial pass as
      sufficient for rollout.
