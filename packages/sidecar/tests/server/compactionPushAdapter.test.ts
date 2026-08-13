/**
 * CompactionPushAdapter unit tests — key behaviour during compaction.
 *
 * Contract:
 *   - inflight key absent → immediately returns true (handler doesn't wait)
 *   - inflight key present, completed → emits `compaction:done:${key}` → resolves true
 *   - inflight key present, timeout → resolves false (handler doesn't block)
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { CompactionPushAdapter } from "../../src/server/compactionPushAdapter.ts";
import type { EmitPushFn } from "../../src/server/pushTypes.ts";

/** No-op emitPush — adapter tests only care about inflight/await state, not push frame content. */
const noopEmit: EmitPushFn = () => {};

function newAdapter(): CompactionPushAdapter {
    return new CompactionPushAdapter(noopEmit);
}

describe("CompactionPushAdapter.awaitCompactionEnd", () => {
    it("returns true immediately when the session is not compressing", async () => {
        const adapter = newAdapter();
        const cwd = "/tmp/ws";
        const sessionId = "sess-not-compacting";

        const start = Date.now();
        const ok = await adapter.awaitCompactionEnd(cwd, sessionId, 5000);
        const elapsed = Date.now() - start;

        assert.equal(ok, true);
        assert.ok(elapsed < 50, `should return fast, took ${elapsed}ms`);
    });

    it("resolves true when compaction:done fires before timeout", async () => {
        const adapter = newAdapter();
        const cwd = "/tmp/ws";
        const sessionId = "sess-compacting-fast";

        // Simulate started (via public entry, matching the production path),
        // then fire finished within 50ms (also via public entry).
        adapter.handleSessionEvent(cwd, sessionId, {
            type: "session_before_compact",
            preparation: { tokensBefore: 100 },
        });
        setTimeout(() => {
            adapter.handleSessionEvent(cwd, sessionId, {
                type: "session_compact",
                compactionEntry: { summary: "compacted", fromHook: true },
            });
        }, 50);

        const ok = await adapter.awaitCompactionEnd(cwd, sessionId, 1000);
        assert.equal(ok, true);
        assert.equal(adapter.isCompressing(cwd, sessionId), false);
    });

    it("returns false when timeout elapses before done fires", async () => {
        const adapter = newAdapter();
        const cwd = "/tmp/ws";
        const sessionId = "sess-compacting-slow";

        // Simulate started, but never finished — let await hit the timeout path.
        adapter.handleSessionEvent(cwd, sessionId, {
            type: "session_before_compact",
            preparation: { tokensBefore: 100 },
        });

        const start = Date.now();
        const ok = await adapter.awaitCompactionEnd(cwd, sessionId, 100);
        const elapsed = Date.now() - start;

        assert.equal(ok, false);
        assert.ok(elapsed >= 95, `should wait ~100ms, took ${elapsed}ms`);
        // isCompressing still true (compression didn't finish; timeout path doesn't clean up)
        assert.equal(adapter.isCompressing(cwd, sessionId), true);
    });

    it("isCompressing reflects inflight membership", () => {
        const adapter = newAdapter();
        const cwd = "/tmp/ws";
        const sessionId = "sess-toggle";

        assert.equal(adapter.isCompressing(cwd, sessionId), false);
        // Simulate started → isCompressing turns true
        adapter.handleSessionEvent(cwd, sessionId, {
            type: "session_before_compact",
            preparation: { tokensBefore: 1 },
        });
        assert.equal(adapter.isCompressing(cwd, sessionId), true);
        // Simulate finished → isCompressing goes back to false
        adapter.handleSessionEvent(cwd, sessionId, {
            type: "session_compact",
            compactionEntry: { summary: "x", fromHook: false },
        });
        assert.equal(adapter.isCompressing(cwd, sessionId), false);
    });
});
