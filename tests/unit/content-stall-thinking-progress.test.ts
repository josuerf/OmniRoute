import test from "node:test";
import assert from "node:assert/strict";

import { createStreamController, pipeWithDisconnect } from "../../open-sse/utils/streamHandler.ts";
import { createStreamContentWatcher } from "../../open-sse/utils/streamReadiness.ts";
import {
  DEFAULT_STREAM_CONTENT_STALL_TIMEOUT_MS,
  getStreamContentStallTimeoutMs,
  resolveContentStallTimeoutMs,
} from "../../src/shared/utils/runtimeTimeouts.ts";

// Live incident (2026-10-01): Claude adaptive thinking under the
// redact-thinking + thinking-token-count betas streams its reasoning phase as
// `thinking_delta` frames whose `thinking` is always "" and that only carry an
// `estimated_tokens` counter. None of them is user-visible output, so the
// content watcher never flipped sawContent() and the content-stall watchdog
// aborted healthy long-thinking turns after ~115s
// ("top=content_block_delta:184 ... reasoning_open=no").

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const sse = (event: string, payload: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;

const MESSAGE_START = sse("message_start", {
  type: "message_start",
  message: { id: "msg_1", type: "message", role: "assistant", content: [] },
});
const THINKING_START = sse("content_block_start", {
  type: "content_block_start",
  index: 0,
  content_block: { type: "thinking", thinking: "", signature: "" },
});
const THINKING_PROGRESS = sse("content_block_delta", {
  type: "content_block_delta",
  index: 0,
  delta: { type: "thinking_delta", thinking: "", estimated_tokens: 50 },
});
const SIGNATURE = sse("content_block_delta", {
  type: "content_block_delta",
  index: 0,
  delta: { type: "signature_delta", signature: "c2lnbmF0dXJl" },
});
const REDACTED_START = sse("content_block_start", {
  type: "content_block_start",
  index: 0,
  content_block: { type: "redacted_thinking", data: "ZW5jcnlwdGVk" },
});
const PING = sse("ping", { type: "ping" });
const TEXT = sse("content_block_delta", {
  type: "content_block_delta",
  index: 1,
  delta: { type: "text_delta", text: "16" },
});

async function readStreamText(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("empty thinking_delta progress frames are reasoning progress, not content", () => {
  const watcher = createStreamContentWatcher();
  watcher.note(MESSAGE_START + THINKING_START + THINKING_PROGRESS + THINKING_PROGRESS);

  assert.equal(watcher.sawContent(), false, "#8649 empty-content semantics must not change");
  // thinking block start + two progress deltas
  assert.equal(watcher.reasoningProgressCount(), 3);
});

test("signature_delta and redacted_thinking blocks count as reasoning progress", () => {
  const watcher = createStreamContentWatcher();
  watcher.note(SIGNATURE + REDACTED_START);

  assert.equal(watcher.sawContent(), false);
  assert.equal(watcher.reasoningProgressCount(), 2);
});

test("ping and lifecycle frames are not reasoning progress", () => {
  const watcher = createStreamContentWatcher();
  watcher.note(MESSAGE_START + PING);
  watcher.note('data: {"type":"response.in_progress","response":{"id":"r","output":[]}}\n\n');

  assert.equal(watcher.reasoningProgressCount(), 0);
});

test("a progress frame split across two network chunks is counted once", () => {
  const watcher = createStreamContentWatcher();
  const cut = Math.floor(THINKING_PROGRESS.length / 2);
  watcher.note(THINKING_PROGRESS.slice(0, cut));
  assert.equal(watcher.reasoningProgressCount(), 0);
  watcher.note(THINKING_PROGRESS.slice(cut));
  assert.equal(watcher.reasoningProgressCount(), 1);
});

test("pipeWithDisconnect keeps a long thinking phase alive past the content-stall budget", async () => {
  const source = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(MESSAGE_START + THINKING_START));
      // 8 x 30ms = ~240ms of reasoning-only frames, well past the 100ms budget.
      for (let i = 0; i < 8; i++) {
        await sleep(30);
        controller.enqueue(encoder.encode(THINKING_PROGRESS));
      }
      controller.enqueue(encoder.encode(SIGNATURE));
      await sleep(30);
      controller.enqueue(encoder.encode(TEXT));
      controller.close();
    },
  });

  let onErrorCalled = false;
  const streamController = createStreamController({
    onError() {
      onErrorCalled = true;
      return true;
    },
  });

  const stream = pipeWithDisconnect(new Response(source), new TransformStream(), streamController, {
    stallTimeoutMs: 5000,
    contentStallTimeoutMs: 100,
  });

  const text = await readStreamText(stream);

  assert.equal(onErrorCalled, false, "reasoning progress must re-arm the content-stall watchdog");
  assert.doesNotMatch(text, /content stall/i);
  assert.match(text, /text_delta/);
});

test("pipeWithDisconnect still flags a stall once reasoning progress stops", async () => {
  const source = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(MESSAGE_START + THINKING_START));
      for (let i = 0; i < 3; i++) {
        await sleep(30);
        controller.enqueue(encoder.encode(THINKING_PROGRESS));
      }
      // Progress stops; only pings keep bytes flowing so the byte-stall
      // watchdog stays quiet and the content watchdog is the one under test.
      for (let i = 0; i < 20; i++) {
        await sleep(20);
        try {
          controller.enqueue(encoder.encode(PING));
        } catch {
          return;
        }
      }
    },
    cancel() {},
  });

  let onErrorEvent: { message: string } | null = null;
  const streamController = createStreamController({
    onError(event: { message: string }) {
      onErrorEvent = event;
      return true;
    },
  });

  const stream = pipeWithDisconnect(new Response(source), new TransformStream(), streamController, {
    stallTimeoutMs: 5000,
    contentStallTimeoutMs: 100,
  });

  const text = await readStreamText(stream);

  assert.ok(onErrorEvent !== null, "pings alone must not keep the content watchdog quiet");
  assert.match(onErrorEvent!.message, /content stall/i);
  assert.match(text, /content stall/i);
});

test("content-stall floor defaults to 300s and is env-overridable", () => {
  assert.equal(DEFAULT_STREAM_CONTENT_STALL_TIMEOUT_MS, 300_000);
  assert.equal(getStreamContentStallTimeoutMs({}), 300_000);
  assert.equal(
    getStreamContentStallTimeoutMs({ STREAM_CONTENT_STALL_TIMEOUT_MS: "600000" }),
    600_000
  );
  assert.equal(getStreamContentStallTimeoutMs({ STREAM_CONTENT_STALL_TIMEOUT_MS: "0" }), 0);

  const warnings: string[] = [];
  assert.equal(
    getStreamContentStallTimeoutMs({ STREAM_CONTENT_STALL_TIMEOUT_MS: "abc" }, (m) =>
      warnings.push(m)
    ),
    300_000
  );
  assert.equal(warnings.length, 1);
});

test("content-stall budget is the larger of readiness and floor, and off when readiness is off", () => {
  // Typical adaptive readiness budgets (80-180s) are lifted to the floor.
  assert.equal(resolveContentStallTimeoutMs(115_000, 300_000), 300_000);
  // A readiness budget above the floor is kept.
  assert.equal(resolveContentStallTimeoutMs(400_000, 300_000), 400_000);
  // Floor 0 restores the previous behavior (readiness budget only).
  assert.equal(resolveContentStallTimeoutMs(115_000, 0), 115_000);
  // Readiness disabled keeps the watchdog disabled.
  assert.equal(resolveContentStallTimeoutMs(0, 300_000), 0);
});
