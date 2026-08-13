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
import { describe, it } from "node:test";

import { withHookTimeout, wrapHook } from "../../src/runtime/hookWiring.ts";

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
        const wrapped = wrapHook(() => new Promise<never>(() => {}), "hanger");
        const started = Date.now();
        const result = await wrapped("x");
        const elapsed = Date.now() - started;
        assert.equal(result, undefined);
        // Allow slack for timer scheduling, but the guard must fire well
        // before an unbounded wait would.
        assert.ok(elapsed < 5_000, `hung hook resolved after ${elapsed}ms, expected ~2s`);
    });

    it("uses the onFailure fallback so tool_call can fail closed", async () => {
        // tool_call treats `undefined` as "allow", so a gatekeeper hook that
        // throws or hangs must fall back to blocking rather than permitting.
        const failClosed = () => ({ block: true, reason: "failed closed" });

        const thrower = wrapHook(
            () => {
                throw new Error("gatekeeper exploded");
            },
            "tool_call",
            failClosed,
        );
        assert.deepEqual(await thrower("rm -rf /"), { block: true, reason: "failed closed" });

        const hanger = wrapHook(() => new Promise<never>(() => {}), "tool_call", failClosed);
        assert.deepEqual(await hanger("rm -rf /"), { block: true, reason: "failed closed" });
    });
});
