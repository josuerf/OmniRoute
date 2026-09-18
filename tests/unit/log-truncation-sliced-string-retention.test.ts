import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MEMORY_EXTRACTION_TEXT_LIMIT,
  capMemoryExtractionText,
  truncateChatLogText,
} from "../../open-sse/handlers/chatCore/logTruncation.ts";

/**
 * Regression guard for the SlicedString retention leak.
 *
 * `String.prototype.slice()` does not copy bytes in V8 when the result is long
 * enough: it returns a SlicedString that points at the parent and keeps the
 * WHOLE parent alive. A 64 KB "preview" of an 8 MB body therefore retains all
 * 8 MB — which is why the heap kept growing on the gateway VM even after the
 * completed-detail byte budget landed: `Buffer.byteLength()` measures the
 * logical length (64 KB), not what is actually retained (8 MB).
 *
 * The retention tests need `--expose-gc` (see `npm run test:heap`); the
 * behavioural tests below run everywhere.
 */

const gc = (globalThis as { gc?: () => void }).gc;
const NO_GC = typeof gc !== "function" ? "requires --expose-gc (npm run test:heap)" : false;

const PARENT_BYTES = 8 * 1024 * 1024;

function collect(): number {
  gc!();
  gc!();
  return process.memoryUsage().heapUsed;
}

/**
 * Builds the parent INSIDE the callee so it goes out of scope on return: once
 * this returns, the only thing that can keep the parent alive is the preview.
 */
function previewDetachedFrom(truncate: (input: string) => string): string {
  const parent = "x".repeat(PARENT_BYTES);
  return truncate(parent);
}

test("truncateChatLogText does not retain the parent string", { skip: NO_GC }, () => {
  const baseline = collect();
  const preview = previewDetachedFrom(truncateChatLogText);
  const retained = collect() - baseline;

  assert.ok(preview.length < PARENT_BYTES / 10, "preview should be a small excerpt");
  assert.ok(
    retained < PARENT_BYTES / 8,
    `preview retained ~${Math.round(retained / 1024)} KB of an ${PARENT_BYTES / 1024 / 1024} MB parent — SlicedString still holds it`
  );
});

test("capMemoryExtractionText does not retain the parent string", { skip: NO_GC }, () => {
  const baseline = collect();
  const preview = previewDetachedFrom(capMemoryExtractionText);
  const retained = collect() - baseline;

  assert.equal(preview.length, MEMORY_EXTRACTION_TEXT_LIMIT);
  assert.ok(
    retained < PARENT_BYTES / 8,
    `preview retained ~${Math.round(retained / 1024)} KB of an ${PARENT_BYTES / 1024 / 1024} MB parent — SlicedString still holds it`
  );
});

// --- behaviour must not change (these run without --expose-gc) ---

test("truncateChatLogText keeps head, tail and the truncation marker", () => {
  const limit = 64 * 1024;
  const body = `HEAD${"a".repeat(limit * 2)}TAIL`;
  const out = truncateChatLogText(body);

  assert.ok(out.startsWith("HEAD"), "head must be preserved");
  assert.ok(out.endsWith("TAIL"), "tail must be preserved");
  assert.match(out, /\[\.\.\.truncated \d+ chars\.\.\.\]/);
});

test("short strings pass through untouched", () => {
  assert.equal(truncateChatLogText("short"), "short");
  assert.equal(capMemoryExtractionText("short"), "short");
});

test("capMemoryExtractionText returns the trailing window", () => {
  const body = `${"a".repeat(MEMORY_EXTRACTION_TEXT_LIMIT)}TAILMARKER`;
  const out = capMemoryExtractionText(body);

  assert.equal(out.length, MEMORY_EXTRACTION_TEXT_LIMIT);
  assert.ok(out.endsWith("TAILMARKER"), "must keep the end of the text");
});

test("lone surrogates survive truncation", () => {
  // Guards the fix itself: flattening through utf8 would replace an unpaired
  // surrogate with U+FFFD and silently corrupt the logged payload.
  const body = `\uD800${"b".repeat(MEMORY_EXTRACTION_TEXT_LIMIT)}`;
  const out = capMemoryExtractionText(body);

  assert.equal(out.length, MEMORY_EXTRACTION_TEXT_LIMIT);
  assert.equal(truncateChatLogText("𐀀 short pair"), "𐀀 short pair");
  assert.equal(capMemoryExtractionText("lone \uD800 kept"), "lone \uD800 kept");
});
