/**
 * useSaveConfigPatch — verify that failed settingsWrite propagates as a
 * rejected promise rather than swallowing the error.
 *
 * Background: the previous implementation caught settingsWrite's rejection,
 * surfaced an `error` state, and resolved successfully. Callers that did
 * `await save(...)` then proceeded to update UI state and restart the sidecar
 * even though disk write failed — a fake-success bug. The fix is to rethrow
 * from `save()` so callers can gate their next steps on actual success.
 */

import { strict as assert } from "node:assert";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, it, vi } from "vitest";

import { useSaveConfigPatch } from "../../src/hooks/useSaveConfigPatch.ts";

afterEach(() => {
    vi.useRealTimers();
});

function makeFakeClient(writeImpl: () => Promise<unknown>): {
    settingsWrite: typeof writeImpl;
    settingsGet: () => Promise<{ global: Record<string, unknown> }>;
} {
    return {
        settingsWrite: writeImpl,
        settingsGet: async () => ({ global: {} }),
    };
}

describe("useSaveConfigPatch", () => {
    it("rethrows settingsWrite failures so callers can gate UI on success", async () => {
        const client = makeFakeClient(async () => {
            throw new Error("disk write failed");
        });
        const { result } = renderHook(() => useSaveConfigPatch(client as never));

        let thrown: Error | undefined;
        await act(async () => {
            try {
                // Patch payload is irrelevant — the test only cares about the
                // rejection propagation; cast through never keeps the test
                // focused on the hook's save semantics.
                await result.current.save({
                    kind: "global",
                    patch: { foo: "bar" },
                } as never);
            } catch (e) {
                thrown = e as Error;
            }
        });

        assert.ok(thrown, "save() must reject when settingsWrite throws");
        assert.match(thrown?.message ?? "", /disk write failed/);
        assert.equal(result.current.error, "disk write failed");
        assert.equal(result.current.saving, false);
    });

    it("resolves when settingsWrite succeeds", async () => {
        const client = makeFakeClient(async () => ({ global: { foo: "bar" } }));
        const { result } = renderHook(() => useSaveConfigPatch(client as never));

        await act(async () => {
            await result.current.save({ kind: "global", patch: { foo: "bar" } } as never);
        });

        assert.equal(result.current.error, null);
        assert.equal(result.current.saving, false);
    });

    it("does not call settingsWrite a second time while a save is in flight", async () => {
        let inflight = false;
        let concurrentCalls = 0;
        const client = makeFakeClient(async () => {
            if (inflight) concurrentCalls += 1;
            inflight = true;
            await new Promise((r) => setTimeout(r, 20));
            inflight = false;
            return { global: {} };
        });
        const { result } = renderHook(() => useSaveConfigPatch(client as never));

        await act(async () => {
            const p1 = result.current.save({ kind: "global", patch: { a: 1 } } as never);
            const p2 = result.current.save({ kind: "global", patch: { a: 2 } } as never);
            await Promise.all([p1, p2]);
        });

        assert.equal(concurrentCalls, 0, "concurrent saves must not overlap");
    });
});
