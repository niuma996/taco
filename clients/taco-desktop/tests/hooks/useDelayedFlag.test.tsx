/**
 * useDelayedFlag — a load that settles inside the delay never shows its
 * indicator, and the indicator drops the moment the load ends.
 */
import { strict as assert } from "node:assert";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, it, vi } from "vitest";

import { useDelayedFlag } from "../../src/hooks/primitives/useDelayedFlag";

beforeEach(() => {
    vi.useFakeTimers();
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe("useDelayedFlag", () => {
    it("stays false when the flag clears inside the delay", () => {
        let active = true;
        const { result, rerender } = renderHook(() => useDelayedFlag(active, 150));
        assert.equal(result.current, false);
        act(() => vi.advanceTimersByTime(100));
        active = false;
        rerender();
        act(() => vi.advanceTimersByTime(200));
        assert.equal(result.current, false);
    });

    it("turns true once the flag has held for the delay", () => {
        const { result } = renderHook(() => useDelayedFlag(true, 150));
        act(() => vi.advanceTimersByTime(149));
        assert.equal(result.current, false);
        act(() => vi.advanceTimersByTime(1));
        assert.equal(result.current, true);
    });

    it("drops to false in the same render the flag clears", () => {
        let active = true;
        const { result, rerender } = renderHook(() => useDelayedFlag(active, 150));
        act(() => vi.advanceTimersByTime(150));
        assert.equal(result.current, true);
        active = false;
        rerender();
        assert.equal(result.current, false);
    });

    it("restarts the delay for the next load", () => {
        let active = true;
        const { result, rerender } = renderHook(() => useDelayedFlag(active, 150));
        act(() => vi.advanceTimersByTime(150));
        active = false;
        rerender();
        active = true;
        rerender();
        assert.equal(result.current, false);
        act(() => vi.advanceTimersByTime(150));
        assert.equal(result.current, true);
    });
});
