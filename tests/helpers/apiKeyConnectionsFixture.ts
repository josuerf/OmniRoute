/**
 * Shared fixture for the self-service Claude-linking work.
 *
 * Builds the API-key / `allowedConnections` matrix that the self-service
 * Claude-linking work needs to exercise repeatedly:
 *   - a key with ZERO connections
 *   - a key allowed exactly ONE non-Claude connection
 *   - a key allowed exactly ONE Claude connection
 *   - a key allowed MULTIPLE connections (two non-Claude + one Claude), to
 *     prove a merge operation preserves pre-existing entries instead of
 *     clobbering them (the existing `updateApiKeyPermissions`
 *     `allowedConnections` branch is a full replace —
 *     `src/lib/db/apiKeys.ts:858-862` — and the new merge helper must not
 *     repeat that mistake).
 *
 * All state lives in a caller-provided temporary SQLite DB (via
 * `process.env.DATA_DIR`, set by the caller BEFORE importing
 * `src/lib/db/core.ts`), following the convention used throughout
 * `tests/unit/*.test.ts` (e.g. `tests/unit/8385-perkey-proxy-global-toggle.test.ts`,
 * `tests/unit/api-key-policy-noauth-allowed-connections.test.ts`). This
 * module does not set `DATA_DIR` or touch `core.resetDbInstance()` itself —
 * callers own the DB lifecycle (creation and teardown) exactly like every
 * other test in this repo.
 *
 * Usage:
 *
 *   import fs from "node:fs";
 *   import os from "node:os";
 *   import path from "node:path";
 *
 *   process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-xyz-"));
 *   process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "test-secret";
 *
 *   const core = await import("../../src/lib/db/core.ts");
 *   const { buildApiKeyConnectionsFixture } = await import(
 *     "../helpers/apiKeyConnectionsFixture.ts"
 *   );
 *
 *   const fixture = await buildApiKeyConnectionsFixture();
 *   // fixture.zeroConnections.apiKey.key            -> Bearer token, 0 allowedConnections
 *   // fixture.oneNonClaudeConnection.apiKey.key      -> 1 allowedConnections (non-Claude)
 *   // fixture.oneClaudeConnection.apiKey.key         -> 1 allowedConnections (Claude)
 *   // fixture.multipleConnections.apiKey.key         -> 3 allowedConnections (mixed)
 *   // fixture.connections.claude.id                  -> the shared Claude connection row id
 *   // fixture.connections.nonClaudeA.id / .nonClaudeB.id
 *
 *   // ...later...
 *   core.resetDbInstance();
 */

import { SELF_USAGE_SCOPE } from "../../src/shared/constants/selfServiceScopes.ts";

export interface FixtureConnection {
  id: string;
  provider: string;
}

export interface FixtureApiKey {
  id: string;
  key: string;
  name: string;
  allowedConnections: string[];
}

export interface ApiKeyConnectionsFixture {
  connections: {
    /** A single Claude (provider === "claude") OAuth connection. */
    claude: FixtureConnection;
    /** Two distinct non-Claude connections, used to build the "multiple" case. */
    nonClaudeA: FixtureConnection;
    nonClaudeB: FixtureConnection;
  };
  /** API key whose allowedConnections is []. */
  zeroConnections: { apiKey: FixtureApiKey };
  /** API key whose allowedConnections is [nonClaudeA.id]. */
  oneNonClaudeConnection: { apiKey: FixtureApiKey };
  /** API key whose allowedConnections is [claude.id]. */
  oneClaudeConnection: { apiKey: FixtureApiKey };
  /** API key whose allowedConnections is [nonClaudeA.id, nonClaudeB.id, claude.id]. */
  multipleConnections: { apiKey: FixtureApiKey };
}

/**
 * Creates the provider_connections + api_keys rows described above in the
 * currently-active DB (`getDbInstance()` via `src/lib/db/core.ts`, selected
 * by `process.env.DATA_DIR`). Must be called after `DATA_DIR` is set and
 * after `src/lib/db/core.ts` has been imported at least once by the caller,
 * matching the rest of the suite's import order.
 */
export async function buildApiKeyConnectionsFixture(): Promise<ApiKeyConnectionsFixture> {
  const providersDb = await import("../../src/lib/db/providers.ts");
  const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");

  const claudeConnection = (await providersDb.createProviderConnection({
    provider: "claude",
    authType: "oauth",
    name: "fixture-claude-connection",
    email: "fixture-claude-user@example.com",
    displayName: "fixture-claude-user@example.com",
    accessToken: "fixture-claude-access-token",
    refreshToken: "fixture-claude-refresh-token",
  })) as unknown as FixtureConnection;

  const nonClaudeA = (await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "fixture-openai-connection-a",
    apiKey: "sk-fixture-openai-a",
  })) as unknown as FixtureConnection;

  const nonClaudeB = (await providersDb.createProviderConnection({
    provider: "gemini",
    authType: "apikey",
    name: "fixture-gemini-connection-b",
    apiKey: "sk-fixture-gemini-b",
  })) as unknown as FixtureConnection;

  async function makeKey(name: string, allowedConnections: string[]): Promise<FixtureApiKey> {
    const created = await apiKeysDb.createApiKey(name, `machine-${name}`, [SELF_USAGE_SCOPE], {
      allowedConnections,
    });
    return {
      id: created.id,
      key: created.key,
      name: created.name,
      allowedConnections,
    };
  }

  const zeroConnections = await makeKey("fixture-key-zero-connections", []);
  const oneNonClaudeConnection = await makeKey("fixture-key-one-non-claude-connection", [
    nonClaudeA.id,
  ]);
  const oneClaudeConnection = await makeKey("fixture-key-one-claude-connection", [
    claudeConnection.id,
  ]);
  const multipleConnections = await makeKey("fixture-key-multiple-connections", [
    nonClaudeA.id,
    nonClaudeB.id,
    claudeConnection.id,
  ]);

  return {
    connections: {
      claude: claudeConnection,
      nonClaudeA,
      nonClaudeB,
    },
    zeroConnections: { apiKey: zeroConnections },
    oneNonClaudeConnection: { apiKey: oneNonClaudeConnection },
    oneClaudeConnection: { apiKey: oneClaudeConnection },
    multipleConnections: { apiKey: multipleConnections },
  };
}
