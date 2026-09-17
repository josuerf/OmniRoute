// Incident 2026-09-16: a fixed 2s Retry-After on `resource_pressure` 503s invited a
// retry storm (73 sheds in one minute) while the process was shedding every request
// with activeHeavy=0, and the shed event carried no detail on *why* -- correlating
// the outage required manually cross-referencing three different log modules. These
// tests cover the Retry-After ramp (chatAdmissionResponses.ts) and the shed-event
// telemetry enrichment (chatBodyAdmission.ts) added to close that gap.
import assert from "node:assert/strict";
import test from "node:test";

import {
  resourcePressureRejectionResponse,
  resourcePressureRetryAfterSeconds,
} from "../../src/shared/middleware/chatAdmissionResponses.ts";
import { describeResourcePressureShedDetail } from "../../src/shared/middleware/chatBodyAdmission.ts";
import {
  reloadResourcePressureRuntime,
  type ResourceSignals,
} from "../../open-sse/utils/resourcePressure.ts";

const MiB = 1024 ** 2;

function signals(observedAtMs: number, heapUsedMb: number): ResourceSignals {
  return {
    observedAtMs,
    v8: { heapUsedBytes: heapUsedMb * MiB, heapLimitBytes: 1_000 * MiB },
    process: {
      rssBytes: 200 * MiB,
      externalBytes: 10 * MiB,
      arrayBuffersBytes: MiB,
      availableBytes: null,
      constrainedBytes: null,
    },
    cgroup: { currentBytes: null, maxBytes: null, highBytes: null, fileBytes: null, events: null },
    psi: null,
  };
}

test("resourcePressureRetryAfterSeconds: floors, ramps, and caps", () => {
  assert.equal(
    resourcePressureRetryAfterSeconds(0),
    2,
    "fresh critical stays at the pre-existing floor"
  );
  assert.equal(resourcePressureRetryAfterSeconds(-500), 2, "negative input clamps to the floor");
  assert.equal(
    resourcePressureRetryAfterSeconds(15_000),
    9,
    "halfway through the ramp (2 + 0.5*13 = 8.5, rounds to 9)"
  );
  assert.equal(
    resourcePressureRetryAfterSeconds(30_000),
    15,
    "ramp ceiling at RESOURCE_PRESSURE_RETRY_AFTER_RAMP_MS"
  );
  assert.equal(
    resourcePressureRetryAfterSeconds(120_000),
    15,
    "never exceeds the ceiling, however long critical persists"
  );
});

test("resourcePressureRejectionResponse: Retry-After header reflects criticalForMs", () => {
  const fresh = resourcePressureRejectionResponse(0);
  assert.equal(fresh.headers.get("Retry-After"), "2");

  const stuck = resourcePressureRejectionResponse(60_000);
  assert.equal(stuck.headers.get("Retry-After"), "15");

  const bareCall = resourcePressureRejectionResponse();
  assert.equal(bareCall.headers.get("Retry-After"), "2", "omitted argument defaults to the floor");
});

test("describeResourcePressureShedDetail: enriches a genuinely critical sample", async (t) => {
  let now = 0;
  const runtime = reloadResourcePressureRuntime({
    nowMs: () => now,
    staleAfterMs: 1_000,
    maxStaleMs: 30_000,
    immediateHeapUsedMb: () => 0,
    sample: async () => signals(now, 950),
    thresholds: {
      sustainedSamplesCritical: 1,
      sustainedSamplesRecovery: 1,
      heapAbsoluteThresholdMb: null,
    },
    selfRestart: { enabled: false },
  });
  t.after(() => {
    reloadResourcePressureRuntime({ selfRestart: { enabled: false } });
  });

  runtime.check();
  await runtime.whenRefreshSettled();
  assert.equal(runtime.getObservation().state.severity, "critical");

  now = 42_000; // advance the same clock the tracker samples with, no new transition
  const detail = describeResourcePressureShedDetail();
  assert.ok(detail, "critical state must produce a detail object");
  assert.equal(detail?.pressureReason, "v8_heap_ratio");
  assert.equal(detail?.heapUsedMb, 950);
  assert.equal(detail?.cgroupPct, null, "no cgroup signal in this fixture");
});

test("describeResourcePressureShedDetail: undefined once no longer critical", async (t) => {
  reloadResourcePressureRuntime({ selfRestart: { enabled: false } });
  t.after(() => {
    reloadResourcePressureRuntime({ selfRestart: { enabled: false } });
  });
  assert.equal(describeResourcePressureShedDetail(), undefined);
});
