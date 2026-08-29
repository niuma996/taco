import { strict as assert } from "node:assert";
import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, it, vi } from "vitest";

import { useRetryOnError } from "../../src/hooks/primitives/useRetryOnError";

afterEach(() => {
    vi.useRealTimers();
});

describe("useRetryOnError", () => {
    it("limits a continuous sequence of fresh errors to five retries", async () => {
        vi.useFakeTimers();
        let retries = 0;
        const { result } = renderHook(() => {
            const [error, setError] = useState<Error | null>(() => new Error("initial failure"));
            useRetryOnError(error, () => {
                retries += 1;
                setError(new Error(`retry ${retries} failed`));
            });
            return { clearError: () => setError(null) };
        });

        for (let index = 0; index < 10; index += 1) {
            await act(async () => {
                await vi.advanceTimersByTimeAsync(8_000);
            });
        }

        assert.equal(retries, 5);

        await act(async () => {
            result.current.clearError();
            await vi.runAllTimersAsync();
        });
        assert.equal(retries, 5, "clearing the error stops further retries");
    });

    it("applies increasing backoff across fresh error objects without resetting", async () => {
        vi.useFakeTimers();
        const fireTimes: number[] = [];
        renderHook(() => {
            const [error, setError] = useState<Error | null>(() => new Error("initial failure"));
            useRetryOnError(error, () => {
                const now = vi.getMockedSystemTime();
                fireTimes.push(now ? now.getTime() : Date.now());
                setError(new Error(`retry ${fireTimes.length} failed`));
            });
            return null;
        });

        // Fire one pending timer at a time so each fire lands exactly on its own
        // scheduled delay, isolating backoff from the advance cadence.
        for (let index = 0; index < 5; index += 1) {
            await act(async () => {
                await vi.advanceTimersToNextTimerAsync();
            });
        }

        // Backoff gaps 1s, 2s, 4s, 8s → fire offsets 1s, 3s, 7s, 15s, 23s from t0.
        // A fresh Error must NOT restart the count at 1s (the pre-fix behavior).
        const base = fireTimes[0];
        const offsets = fireTimes.map((time) => time - base);
        assert.deepEqual(offsets, [0, 2_000, 6_000, 14_000, 22_000]);
    });
});
