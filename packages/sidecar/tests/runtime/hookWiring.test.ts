/**
 * Hook timeout guard — `wrapHook` / `withHookTimeout` semantics.
 *
 * Covers: fast hooks pass through untouched, throwing / rejecting hooks
 * degrade to `undefined`, and a hung hook (a promise that never settles)
 * times out instead of blocking the caller.
 *
 * Run:
 *   pnpm --filter @taco-ai/sidecar test
 */

import { strict as assert } from "node:assert";
import { describe, it, mock } from "node:test";

import {
    HOOK_TIMEOUT_MS,
    withHookTimeout,
    wrapHook,
} from "../../src/runtime/harness/hookWiring.ts";

describe("withHookTimeout", () => {
    it("resolves fast promises with the original value", async () => {
        assert.equal(await withHookTimeout(Promise.resolve(42), "fast"), 42);
        assert.equal(await withHookTimeout(Promise.resolve("ok"), "fast"), "ok");
    });

    it("propagates rejections from fast promises", async () => {
        await assert.rejects(
            () => withHookTimeout(Promise.reject(new Error("boom")), "fast"),
            /boom/,
        );
    });
});

describe("wrapHook", () => {
    it("passes through a normal hook result", async () => {
        const wrapped = wrapHook((e: number) => e * 2, "double");
        assert.equal(await wrapped(21), 42);
    });

    it("degrades a sync-throwing hook to undefined", async () => {
        const wrapped = wrapHook(() => {
            throw new Error("sync boom");
        }, "thrower");
        assert.equal(await wrapped("x"), undefined);
    });

    it("degrades a rejecting hook to undefined", async () => {
        const wrapped = wrapHook(async () => {
            throw new Error("async boom");
        }, "rejector");
        assert.equal(await wrapped("x"), undefined);
    });

    it("times out a hung hook to undefined instead of blocking forever", async () => {
        // Mock setTimeout so the 2s deadline fires on a synthetic tick —
        // eliminates the wall-clock sensitivity that made this case
        // intermittently fail under full-suite event-loop pressure.
        mock.timers.enable({ apis: ["setTimeout"] });
        try {
            const wrapped = wrapHook(() => new Promise<never>(() => {}), "hanger");
            const hung = wrapped("x");
            mock.timers.tick(HOOK_TIMEOUT_MS);
            assert.equal(await hung, undefined);
        } finally {
            mock.timers.reset();
        }
    });

    it("uses the onFailure fallback so tool_call can fail closed", async () => {
        // tool_call treats `undefined` as "allow", so a gatekeeper hook that
        // throws or hangs must fall back to blocking rather than permitting.
        mock.timers.enable({ apis: ["setTimeout"] });
        try {
            const failClosed = (): { block: true; reason: string } => ({
                block: true,
                reason: "failed closed",
            });

            const thrower = wrapHook(
                () => {
                    throw new Error("gatekeeper exploded");
                },
                "tool_call",
                failClosed,
            );
            assert.deepEqual(await thrower("rm -rf /"), { block: true, reason: "failed closed" });

            const hanger = wrapHook(() => new Promise<never>(() => {}), "tool_call", failClosed);
            const hung = hanger("rm -rf /");
            mock.timers.tick(HOOK_TIMEOUT_MS);
            assert.deepEqual(await hung, { block: true, reason: "failed closed" });
        } finally {
            mock.timers.reset();
        }
    });
});
