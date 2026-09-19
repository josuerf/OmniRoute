import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createResourcePressureTracker,
  DEFAULT_RESOURCE_PRESSURE_THRESHOLDS,
  type ResourceSignals,
} from "../../open-sse/utils/resourcePressurePolicy.ts";

/**
 * IAF-492 — the admission gate must act BEFORE the container is restarted.
 *
 * Production geometry, measured on the gateway VM on 2026-09-19:
 *   - `mem_limit: 11g` → memory.max = 11_811_160_064
 *   - the external watchdog (`/root/scripts/omniroute-heap-watchdog.sh`,
 *     trigger A) restarts the container at memory.current / memory.max >= 90%
 *   - the charge is anon-dominated: memory.stat `file` was 382_210_048, i.e.
 *     3.2% of the limit, against 3_332_812_800 of anon
 *
 * The guard ratios the WORKING SET (current − file) so reclaimable page cache
 * cannot trip it (incident 2026-08-29). That is correct, but it means the
 * guard's own critical ratio has to clear `watchdog ratio − cache fraction`,
 * or the watchdog always wins the race and the gate never sheds a thing —
 * which is exactly what `admission_sheds=0` showed on the day of the incident.
 */
const MEMORY_MAX_BYTES = 11_811_160_064;
const WATCHDOG_RESTART_RATIO = 0.9;
const OBSERVED_FILE_BYTES = 382_210_048;
const OBSERVED_CACHE_FRACTION = OBSERVED_FILE_BYTES / MEMORY_MAX_BYTES;

function cgroupSignals(currentBytes: number, fileBytes: number, observedAtMs: number) {
  return {
    observedAtMs,
    v8: { heapUsedBytes: 100 * 1024 ** 2, heapLimitBytes: 8192 * 1024 ** 2 },
    process: {
      rssBytes: 200 * 1024 ** 2,
      externalBytes: 10 * 1024 ** 2,
      arrayBuffersBytes: 1024 ** 2,
      availableBytes: null,
      constrainedBytes: null,
    },
    cgroup: {
      currentBytes,
      maxBytes: MEMORY_MAX_BYTES,
      highBytes: null,
      fileBytes,
      events: { low: 0, high: 0, max: 0, oom: 0, oom_kill: 0 },
    },
    psi: null,
  } satisfies ResourceSignals;
}

describe("resource pressure vs the external container watchdog", () => {
  it("leaves the default critical ratio below the watchdog restart trigger", () => {
    assert.ok(
      DEFAULT_RESOURCE_PRESSURE_THRESHOLDS.criticalRatio <
        WATCHDOG_RESTART_RATIO - OBSERVED_CACHE_FRACTION,
      `criticalRatio ${DEFAULT_RESOURCE_PRESSURE_THRESHOLDS.criticalRatio} must clear ` +
        `${(WATCHDOG_RESTART_RATIO - OBSERVED_CACHE_FRACTION).toFixed(4)} — otherwise the ` +
        "working-set ratio can never reach critical before the watchdog restarts the container"
    );
  });

  it("sheds at the watchdog's restart point instead of being restarted", () => {
    const tracker = createResourcePressureTracker();
    const atWatchdogTrigger = Math.round(MEMORY_MAX_BYTES * WATCHDOG_RESTART_RATIO);

    tracker.observe(cgroupSignals(atWatchdogTrigger, OBSERVED_FILE_BYTES, 1_000));
    const state = tracker.observe(cgroupSignals(atWatchdogTrigger, OBSERVED_FILE_BYTES, 2_000));

    assert.equal(state.severity, "critical", "the gate must shed before the watchdog fires");
    assert.equal(state.reason, "cgroup_ratio");
  });

  it("still ignores reclaimable page cache at the tightened defaults", () => {
    // Regression guard for incident 2026-08-29: a cache-heavy container is
    // healthy. 95% raw charge that is nearly all page cache is a 40% working
    // set and must stay out of every elevated band.
    const tracker = createResourcePressureTracker();
    const current = Math.round(MEMORY_MAX_BYTES * 0.95);
    const file = Math.round(MEMORY_MAX_BYTES * 0.55);

    tracker.observe(cgroupSignals(current, file, 1_000));
    const state = tracker.observe(cgroupSignals(current, file, 2_000));

    assert.equal(state.severity, "normal", "reclaimable cache is not pressure");
  });

  it("releases the latch once the working set drops back under the recovery ratio", () => {
    const tracker = createResourcePressureTracker();
    const atWatchdogTrigger = Math.round(MEMORY_MAX_BYTES * WATCHDOG_RESTART_RATIO);

    tracker.observe(cgroupSignals(atWatchdogTrigger, OBSERVED_FILE_BYTES, 1_000));
    assert.equal(
      tracker.observe(cgroupSignals(atWatchdogTrigger, OBSERVED_FILE_BYTES, 2_000)).severity,
      "critical"
    );

    const recovered = Math.round(MEMORY_MAX_BYTES * 0.5);
    const state = tracker.observe(cgroupSignals(recovered, OBSERVED_FILE_BYTES, 3_000));

    assert.equal(state.severity, "normal", "a drained working set must clear the latch");
  });
});
