/**
 * chatCore Quota Share enforcement PRE-hook (B/F7) and its combo soft-penalty propagation (G2)
 * (chatCore god-file decomposition, slice 2).
 *
 * Extracted byte-identically from handleChatCore. Runs after provider/model/credentials/apiKeyInfo
 * are fully resolved, before the dispatcher. Fail-open per B16: errors → allow. A `block` decision
 * finalizes the pending-request slot registered at handler entry and returns the 429 error result
 * (createErrorResult) the handler sends; otherwise it returns null (after flagging a soft deprioritize on the current combo
 * candidate when the pool asks for it). The pending-request finalization is injected by the
 * handler (`finalizePendingRequest`) so this engine leaf takes no new open-sse → src import edge.
 */

import type { EnforceDecision, EnforceInput } from "@/lib/quota/types";
import { createErrorResult } from "../../utils/error.ts";

type LoggerLike =
  { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void } | null | undefined;

export async function runQuotaSharePreHook({
  apiKeyInfo,
  credentials,
  provider,
  model,
  isCombo,
  comboStepId,
  comboExecutionKey,
  finalizePendingRequest,
  log,
  enforce,
}: {
  apiKeyInfo: { id?: string } | null | undefined;
  credentials: { connectionId?: string } | null | undefined;
  provider: string;
  model: string;
  isCombo: boolean;
  comboStepId: string | null;
  comboExecutionKey: string | null;
  finalizePendingRequest: () => void;
  log?: LoggerLike;
  /** Test seam; defaults to enforceQuotaShare. */
  enforce?: (input: EnforceInput) => Promise<EnforceDecision>;
}): Promise<ReturnType<typeof createErrorResult> | null> {
  let quotaSoftDeprioritize = false;
  if (apiKeyInfo?.id && credentials?.connectionId) {
    try {
      const enforceQuotaShare = enforce ?? (await import("@/lib/quota/enforce")).enforceQuotaShare;
      const decision = await enforceQuotaShare({
        apiKeyId: apiKeyInfo.id,
        connectionId: credentials.connectionId,
        provider: provider ?? "unknown",
        // Resolved model id (post background-redirect / alias) — the same scope the
        // router/log use. Operators configure per-(key,model) caps against THIS id.
        model: model || undefined,
        estimatedCost: {},
      }).catch((err: unknown): EnforceDecision => {
        log?.warn?.(
          "QUOTA_SHARE",
          `enforceQuotaShare failed; fail-open: ${err instanceof Error ? err.message : String(err)}`
        );
        return { kind: "allow" as const };
      });

      if (decision.kind === "block") {
        log?.warn?.(
          "QUOTA_SHARE",
          `[quotaShare] blocked apiKeyId=${apiKeyInfo.id} provider=${provider ?? "unknown"}: ${decision.reason}`
        );
        // Finalize the pending-request slot registered at handler entry — this
        // return path never reaches the upstream, and without the decrement the
        // pending detail lingers as an orphaned status-0 call-log row until the
        // reaper sweeps it (mirrors the other pre-upstream error returns).
        finalizePendingRequest();
        // Same result shape as every other pre-upstream rejection in handleChatCore.
        // A bare Response here made callers read `result.response.headers` off
        // undefined, turning this 429 into a 502 that the combo treated as a
        // provider failure (skipping every remaining target of the provider).
        return createErrorResult(
          429,
          decision.reason,
          decision.retryAfterSeconds ? decision.retryAfterSeconds * 1000 : null
        );
      }

      if (decision.kind === "allow" && decision.deprioritize) {
        quotaSoftDeprioritize = true;
        log?.info?.(
          "QUOTA_SHARE",
          `[quotaShare] soft deprioritize active for apiKeyId=${apiKeyInfo.id} provider=${provider ?? "unknown"}`
        );
      }
    } catch (err) {
      // Outer fail-open guard — should not be reached (inner .catch covers it)
      log?.warn?.(
        "QUOTA_SHARE",
        `[quotaShare] enforceQuotaShare unexpected error; fail-open: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  // G2: Propagate soft penalty to the current candidate so combo scoring can deprioritize.
  if (quotaSoftDeprioritize && isCombo && comboStepId) {
    try {
      const { setCandidateQuotaSoftPenalty } = await import("../../services/combo");
      setCandidateQuotaSoftPenalty(comboExecutionKey, comboStepId, true);
    } catch (err) {
      log?.warn?.(
        "QUOTA_SHARE",
        `[quotaShare] could not set soft penalty on candidate: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  return null;
}
