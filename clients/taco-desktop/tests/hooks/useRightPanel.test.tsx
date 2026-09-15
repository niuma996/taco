import { strict as assert } from "node:assert";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, it } from "vitest";

import { useRightPanel } from "../../src/hooks/useRightPanel";
import { LS_RIGHT_PANEL_WIDTH } from "../../src/lib/clientSettings";

/** happy-dom defaults to 1024x768; set it explicitly so bounds are predictable. */
function setViewport(width: number) {
    Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
}

beforeEach(() => {
    localStorage.clear();
    setViewport(1440);
});

afterEach(() => {
    localStorage.clear();
});

describe("useRightPanel — exclusivity", () => {
    it("starts closed", () => {
        const { result } = renderHook(() => useRightPanel());
        assert.equal(result.current.panel, "none");
    });

    it("toggle opens, then closes the same panel", () => {
        const { result } = renderHook(() => useRightPanel());
        act(() => result.current.toggle("tasks"));
        assert.equal(result.current.panel, "tasks");
        act(() => result.current.toggle("tasks"));
        assert.equal(result.current.panel, "none");
    });

    it("toggling a different panel switches rather than stacking", () => {
        const { result } = renderHook(() => useRightPanel());
        act(() => result.current.toggle("tasks"));
        act(() => result.current.toggle("subagents"));
        assert.equal(result.current.panel, "subagents", "one slot, last wins");
        act(() => result.current.toggle("files"));
        assert.equal(result.current.panel, "files");
    });

    it("show opens unconditionally and never toggles an open panel shut", () => {
        const { result } = renderHook(() => useRightPanel());
        act(() => result.current.show("subagents"));
        assert.equal(result.current.panel, "subagents");
        // The auto-open path fires repeatedly; it must stay open.
        act(() => result.current.show("subagents"));
        assert.equal(result.current.panel, "subagents");
    });

    it("close resets to none from any panel", () => {
        const { result } = renderHook(() => useRightPanel());
        act(() => result.current.show("files"));
        act(() => result.current.close());
        assert.equal(result.current.panel, "none");
    });
});

describe("useRightPanel — width", () => {
    it("falls back to the default width with nothing persisted", () => {
        const { result } = renderHook(() => useRightPanel());
        assert.equal(result.current.width, 280);
    });

    it("restores a persisted width", () => {
        localStorage.setItem(LS_RIGHT_PANEL_WIDTH, JSON.stringify(420));
        const { result } = renderHook(() => useRightPanel());
        assert.equal(result.current.width, 420);
    });

    it("clamps a persisted width that no longer fits the viewport", () => {
        // 900 - 220 (sidebar) - 480 (chat floor) = 200 → lower bound 220 wins.
        localStorage.setItem(LS_RIGHT_PANEL_WIDTH, JSON.stringify(600));
        setViewport(900);
        const { result } = renderHook(() => useRightPanel(false));
        assert.equal(result.current.width, 220);
    });

    it("does not overwrite the stored preference when clamping down", () => {
        localStorage.setItem(LS_RIGHT_PANEL_WIDTH, JSON.stringify(600));
        setViewport(900);
        renderHook(() => useRightPanel(false));
        assert.equal(
            localStorage.getItem(LS_RIGHT_PANEL_WIDTH),
            JSON.stringify(600),
            "a narrow window renders narrower but keeps the preference",
        );
    });

    it("collapsing the sidebar raises the ceiling with no resize event", () => {
        localStorage.setItem(LS_RIGHT_PANEL_WIDTH, JSON.stringify(600));
        setViewport(1100);
        const { result, rerender } = renderHook(
            ({ collapsed }: { collapsed: boolean }) => useRightPanel(collapsed),
            { initialProps: { collapsed: false } },
        );
        // Expanded: 1100 - 220 - 480 = 400, so the 600 preference is clipped.
        assert.equal(result.current.width, 400);

        rerender({ collapsed: true });
        // Collapsed the ceiling rises to 1100 - 0 - 480 = 620, so the clipped
        // 600 preference is restored in full — not grown past what was asked.
        assert.equal(result.current.width, 600);
    });

    it("re-clamps on window resize", () => {
        localStorage.setItem(LS_RIGHT_PANEL_WIDTH, JSON.stringify(600));
        setViewport(1440);
        const { result } = renderHook(() => useRightPanel(false));
        // 1440 - 288 - 480 = 672 → capped at the 640 hard max.
        assert.equal(result.current.width, 600);

        setViewport(1000);
        act(() => {
            window.dispatchEvent(new Event("resize"));
        });
        // 1000 - 220 - 480 = 300.
        assert.equal(result.current.width, 300);
    });

    it("exposes a separator handle carrying the current width", () => {
        const { result } = renderHook(() => useRightPanel());
        assert.equal(result.current.resizeHandleProps.role, "separator");
        assert.equal(result.current.resizeHandleProps["aria-valuenow"], 280);
    });
});
