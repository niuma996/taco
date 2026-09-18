/**
 * CompactionPushAdapter unit tests — key behaviour during compaction.
 *
 * Contract:
 *   - inflight key absent → immediately returns true (handler doesn't wait)
 *   - inflight key present, committed → emits `compaction:done:${key}` → resolves true
 *   - inflight key present, timeout → resolves false (handler doesn't block)
 *
 * The frames below use the production event names (`taco_compaction_start` /
 * `taco_compaction_end`), which is what the controller's lifecycle sink emits.
 * pi 0.85 emits no `session_before_compact` / `session_compact` onto that bus.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { asSessionId, asWorkspaceId } from "@taco-ai/protocol";

import { CompactionPushAdapter } from "../../src/server/compactionPushAdapter.ts";
import type { EmitPushFn } from "../../src/server/pushTypes.ts";

/** No-op emitPush — the interlock tests only care about inflight/await state. */
const noopEmit: EmitPushFn = () => {};

function newAdapter(): CompactionPushAdapter {
    return new CompactionPushAdapter(noopEmit);
}

/** An adapter plus every push frame it emitted, in order. */
function newRecordingAdapter(): {
    adapter: CompactionPushAdapter;
    frames: Array<{ method: string; params?: unknown }>;
} {
    const frames: Array<{ method: string; params?: unknown }> = [];
    const adapter = new CompactionPushAdapter((method, _cwd, _sid, params) => {
        frames.push({ method: String(method), params });
    });
    return { adapter, frames };
}

/** Start a compaction the way the controller's lifecycle sink does. */
function start(
    adapter: CompactionPushAdapter,
    cwd: unknown,
    sessionId: unknown,
    tokensBefore = 100,
): void {
    adapter.handleSessionEvent(cwd as never, sessionId as never, {
        type: "taco_compaction_start",
        tokensBefore,
    });
}

/** End a compaction the way the controller's lifecycle sink does. */
function end(
    adapter: CompactionPushAdapter,
    cwd: unknown,
    sessionId: unknown,
    payload: { committed?: { summaryChars: number; fromHook: boolean }; reason?: string },
): void {
    adapter.handleSessionEvent(cwd as never, sessionId as never, {
        type: "taco_compaction_end",
        ...payload,
    });
}

describe("CompactionPushAdapter.awaitCompactionEnd", () => {
    it("returns true immediately when the session is not compressing", async () => {
        const adapter = newAdapter();
        const cwd = asWorkspaceId("/tmp/ws");
        const sessionId = asSessionId("sess-not-compacting");

        const start = Date.now();
        const ok = await adapter.awaitCompactionEnd(cwd, sessionId, 5000);
        const elapsed = Date.now() - start;

        assert.equal(ok, true);
        assert.ok(elapsed < 50, `should return fast, took ${elapsed}ms`);
    });

    it("resolves true when compaction:done fires before timeout", async () => {
        const adapter = newAdapter();
        const cwd = asWorkspaceId("/tmp/ws");
        const sessionId = asSessionId("sess-compacting-fast");

        start(adapter, cwd, sessionId);
        setTimeout(() => {
            end(adapter, cwd, sessionId, {
                committed: { summaryChars: 9, fromHook: true },
            });
        }, 50);

        const ok = await adapter.awaitCompactionEnd(cwd, sessionId, 1000);
        assert.equal(ok, true);
        assert.equal(adapter.isCompressing(cwd, sessionId), false);
    });

    it("returns false when timeout elapses before done fires", async () => {
        const adapter = newAdapter();
        const cwd = asWorkspaceId("/tmp/ws");
        const sessionId = asSessionId("sess-compacting-slow");

        // Simulate started, but never finished — let await hit the timeout path.
        start(adapter, cwd, sessionId);

        const before = Date.now();
        const ok = await adapter.awaitCompactionEnd(cwd, sessionId, 100);
        const elapsed = Date.now() - before;

        assert.equal(ok, false);
        assert.ok(elapsed >= 95, `should wait ~100ms, took ${elapsed}ms`);
        // isCompressing still true (compression didn't finish; timeout path doesn't clean up)
        assert.equal(adapter.isCompressing(cwd, sessionId), true);
    });

    it("isCompressing reflects inflight membership", () => {
        const adapter = newAdapter();
        const cwd = asWorkspaceId("/tmp/ws");
        const sessionId = asSessionId("sess-toggle");

        assert.equal(adapter.isCompressing(cwd, sessionId), false);
        start(adapter, cwd, sessionId, 1);
        assert.equal(adapter.isCompressing(cwd, sessionId), true);
        end(adapter, cwd, sessionId, { committed: { summaryChars: 1, fromHook: false } });
        assert.equal(adapter.isCompressing(cwd, sessionId), false);
    });
});

describe("CompactionPushAdapter finished-frame outcome", () => {
    /** Pull the CompactionFinished params out of a recorded frame list. */
    function finishedParams(frames: Array<{ method: string; params?: unknown }>): {
        failed?: boolean;
        reason?: string;
        failureMessage?: string;
        summaryChars?: number;
        fromHook?: boolean;
    } {
        const frame = frames.find((f) => f.method === "session.compaction_finished");
        assert.ok(frame, "a CompactionFinished frame must be emitted");
        return frame.params as never;
    }

    it("reports success when the end signal carries a committed summary", () => {
        // Regression: success was previously derived from a `session_compact`
        // event that pi 0.85 never emits, so every successful compaction was
        // pushed to the desktop as a failure.
        const { adapter, frames } = newRecordingAdapter();
        const cwd = asWorkspaceId("/tmp/ws");
        const sessionId = asSessionId("sess-commit");

        start(adapter, cwd, sessionId, 4200);
        end(adapter, cwd, sessionId, {
            committed: { summaryChars: 1234, fromHook: true },
        });

        const finished = finishedParams(frames);
        assert.equal(finished.failed, false, "a committed summary must not be reported as failed");
        assert.equal(finished.summaryChars, 1234);
        assert.equal(finished.fromHook, true);
        assert.equal(
            finished.failureMessage,
            undefined,
            "a successful compaction must not carry failure copy",
        );
    });

    it("reports failure carrying the classification when the end signal has none", () => {
        const { adapter, frames } = newRecordingAdapter();
        const cwd = asWorkspaceId("/tmp/ws");
        const sessionId = asSessionId("sess-nothing");

        start(adapter, cwd, sessionId);
        end(adapter, cwd, sessionId, { reason: "nothing" });

        const finished = finishedParams(frames);
        assert.equal(finished.failed, true);
        assert.equal(finished.reason, "nothing");
        assert.equal(finished.summaryChars, 0);
    });

    it("keeps the generic failure copy when nothing is classified", () => {
        const { adapter, frames } = newRecordingAdapter();
        const cwd = asWorkspaceId("/tmp/ws");
        const sessionId = asSessionId("sess-unclassified");

        start(adapter, cwd, sessionId);
        end(adapter, cwd, sessionId, {});

        const finished = finishedParams(frames);
        assert.equal(finished.failed, true);
        assert.equal(finished.reason, undefined);
        assert.equal(finished.failureMessage, "compaction did not commit a summary");
    });
});
