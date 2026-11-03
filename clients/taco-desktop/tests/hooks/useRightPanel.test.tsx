import { strict as assert } from "node:assert";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, it } from "vitest";

import { useRightPanel } from "../../src/hooks/useRightPanel";
import { LS_RIGHT_PANEL_RATIO, LS_RIGHT_PANEL_WIDTH_LEGACY } from "../../src/lib/clientSettings";

/** happy-dom defaults to 1024x768; set it explicitly so bounds are predictable. */
function setViewport(width: number) {
    Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
}

/**
 * The viewport width is picked up on the next animation frame. happy-dom
 * drives rAF through setImmediate, so the wait has to cross a check phase —
 * one timer round is not enough.
 */
async function flushResize() {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
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
        assert.equal(result.current.panel, "tasks");
        act(() => result.current.toggle("subagents"));
        assert.equal(result.current.panel, "subagents");
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
    it("falls back to the default share with nothing persisted", () => {
        const { result } = renderHook(() => useRightPanel());
        // 30% of the 1096px chat area (1440 - 56 rail - 288 sidebar).
        assert.equal(result.current.width, 329);
    });

    it("restores a persisted share", () => {
        localStorage.setItem(LS_RIGHT_PANEL_RATIO, JSON.stringify(0.4));
        const { result } = renderHook(() => useRightPanel());
        assert.equal(result.current.width, 438);
    });

    it("keeps the share when the sidebar collapses", () => {
        const { result } = renderHook(() => useRightPanel(true));
        // Same 30%, but the chat area is now the whole layout.
        assert.equal(result.current.width, 415);
    });

    it("raises the share to the 250px floor on a narrow layout", () => {
        // 800 - 56 - 220 = 524px chat area → the floor needs 48% of it.
        setViewport(800);
        const { result } = renderHook(() => useRightPanel(false));
        assert.equal(result.current.width, 250);
    });

    it("never renders below the default share", () => {
        // 30% of the 1096px chat area is 329px — the wider of the two floors.
        localStorage.setItem(LS_RIGHT_PANEL_RATIO, JSON.stringify(0.05));
        const { result } = renderHook(() => useRightPanel(false));
        assert.equal(result.current.width, 329);
    });

    it("lets the 50% ceiling win over the floor on a very narrow layout", () => {
        // 600 - 56 - 220 = 324px chat area → half of it is 162px.
        setViewport(600);
        const { result } = renderHook(() => useRightPanel(false));
        assert.equal(result.current.width, 162);
    });

    it("does not overwrite the stored preference when clamping down", () => {
        localStorage.setItem(LS_RIGHT_PANEL_RATIO, JSON.stringify(0.5));
        setViewport(800);
        renderHook(() => useRightPanel(false));
        assert.equal(
            localStorage.getItem(LS_RIGHT_PANEL_RATIO),
            JSON.stringify(0.5),
            "a narrow layout renders narrower but keeps the preference",
        );
    });

    it("re-derives the width on window resize", async () => {
        const { result } = renderHook(() => useRightPanel(false));
        assert.equal(result.current.width, 329);

        setViewport(1000);
        window.dispatchEvent(new Event("resize"));
        await flushResize();
        // 1000 - 56 - 220 = 724px chat area → the floor needs 34.5% of it.
        assert.equal(result.current.width, 250);
    });

    it("migrates a legacy pixel width into a share, once", () => {
        localStorage.setItem(LS_RIGHT_PANEL_WIDTH_LEGACY, JSON.stringify(360));
        const { result } = renderHook(() => useRightPanel(false));
        assert.equal(result.current.width, 360, "the hand-tuned width survives");
        assert.equal(localStorage.getItem(LS_RIGHT_PANEL_WIDTH_LEGACY), null, "legacy key dropped");
        assert.ok(localStorage.getItem(LS_RIGHT_PANEL_RATIO), "the share is stored instead");
    });

    it("raises a migrated width that falls under the new floor", () => {
        localStorage.setItem(LS_RIGHT_PANEL_WIDTH_LEGACY, JSON.stringify(280));
        const { result } = renderHook(() => useRightPanel(false));
        assert.equal(result.current.width, 329, "280px is under the 30% floor");
    });

    it("exposes a separator handle carrying the current share", () => {
        const { result } = renderHook(() => useRightPanel());
        assert.equal(result.current.resizeHandleProps.role, "separator");
        assert.equal(result.current.resizeHandleProps["aria-valuenow"], 30);
    });
});
