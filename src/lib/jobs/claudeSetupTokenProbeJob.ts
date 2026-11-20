/**
 * Registry adapter for the active `claude setup-token` probe (D2).
 *
 * The job ticks hourly; the handler probes only connections whose last probe is older than
 * CLAUDE_SETUP_TOKEN_PROBE_INTERVAL_HOURS (default 24; `0`/`false`/`off` disables it), serially.
 * It is skipped in build and automated-test processes, like the token health check.
 */
import { isHealthCheckDisabled } from "@/lib/tokenHealthCheck";
import { probeDueClaudeSetupTokenConnections } from "@/lib/oauth/utils/claudeSetupTokenProbe";
import type { JobRegistry } from "@/lib/jobRegistry/registry";

const CLAUDE_SETUP_TOKEN_PROBE_TICK_MS = 60 * 60 * 1000;

export function registerClaudeSetupTokenProbe(registry: JobRegistry): void {
  const now = new Date().toISOString();
  registry.register({
    id: "claude_setup_token_probe",
    type: "interval",
    cron: null,
    intervalMs: CLAUDE_SETUP_TOKEN_PROBE_TICK_MS,
    enabled: true,
    envFlag: null,
    config: {},
    createdAt: now,
    updatedAt: now,
    handler: async () => {
      if (isHealthCheckDisabled()) return { success: true, recordsAffected: 0 };
      const { probed } = await probeDueClaudeSetupTokenConnections();
      return { success: true, recordsAffected: probed };
    },
  });
}
