import { strict as assert } from "node:assert";
import { act, renderHook } from "@testing-library/react";
import { describe, it, vi } from "vitest";

import { useDragResize } from "../../src/hooks/primitives/useDragResize";

/** Clamp to [220, 640] — the right panel's real bounds, viewport aside. */
const clamp = (raw: number) => Math.round(Math.max(220, Math.min(640, raw)));

function setup(overrides: Partial<Parameters<typeof useDragResize>[0]> = {}, onCommit = vi.fn()) {
    const { result } = renderHook(() =>
        useDragResize({ initial: 300, min: 220, max: 640, clamp, onCommit, ...overrides }),
    );
    return { result, onCommit };
}

/** Dispatch a pointerdown through the handle, then move / release on window. */
function drag(handleProps: { onPointerDown: (e: never) => void }, from: number, to: number) {
    act(() => {
        handleProps.onPointerDown({ clientX: from } as never);
    });
    act(() => {
        window.dispatchEvent(new MouseEvent("pointermove", { clientX: to }));
    });
    act(() => {
        window.dispatchEvent(new MouseEvent("pointerup"));
    });
}

describe("useDragResize", () => {
    it("clamps the initial width instead of trusting it", () => {
        const { result } = setup({ initial: 9999 });
        assert.equal(result.current.width, 640);
    });

    it("dragging left widens the right-anchored panel", () => {
        const { result, onCommit } = setup();
        // Pointer moves left by 100 → panel gains 100.
        drag(result.current.handleProps, 800, 700);
        assert.equal(result.current.width, 400);
        assert.equal(onCommit.mock.calls.at(-1)?.[0], 400);
    });

    it("dragging right narrows the panel and clamps at the lower bound", () => {
        const { result } = setup();
        drag(result.current.handleProps, 800, 1000);
        assert.equal(result.current.width, 220);
    });

    it("commits the final width once on release, not per move", () => {
        const { result, onCommit } = setup();
        act(() => {
            result.current.handleProps.onPointerDown({ clientX: 800 } as never);
        });
        act(() => {
            window.dispatchEvent(new MouseEvent("pointermove", { clientX: 750 }));
        });
        act(() => {
            window.dispatchEvent(new MouseEvent("pointermove", { clientX: 700 }));
        });
        assert.equal(onCommit.mock.calls.length, 0, "no persist mid-drag");
        act(() => {
            window.dispatchEvent(new MouseEvent("pointerup"));
        });
        assert.equal(onCommit.mock.calls.length, 1);
        assert.equal(onCommit.mock.calls[0]?.[0], 400);
    });

    it("pointercancel ends the drag and restores body styles", () => {
        const { result, onCommit } = setup();
        act(() => {
            result.current.handleProps.onPointerDown({ clientX: 800 } as never);
        });
        assert.equal(document.body.style.cursor, "col-resize");
        act(() => {
            window.dispatchEvent(new MouseEvent("pointermove", { clientX: 760 }));
        });
        act(() => {
            window.dispatchEvent(new Event("pointercancel"));
        });
        assert.equal(onCommit.mock.calls.length, 1);
        assert.equal(document.body.style.cursor, "", "cursor released");
        assert.equal(document.body.style.userSelect, "", "text selection re-enabled");
        // A stale pointermove after cancel must not keep resizing.
        const settled = result.current.width;
        act(() => {
            window.dispatchEvent(new MouseEvent("pointermove", { clientX: 400 }));
        });
        assert.equal(result.current.width, settled);
    });

    it("window blur ends the drag (pointer released outside the window)", () => {
        const { result, onCommit } = setup();
        act(() => {
            result.current.handleProps.onPointerDown({ clientX: 800 } as never);
        });
        act(() => {
            window.dispatchEvent(new Event("blur"));
        });
        assert.equal(onCommit.mock.calls.length, 1);
        assert.equal(document.body.style.cursor, "");
    });

    it("ArrowLeft widens and ArrowRight narrows by the keyboard step", () => {
        const { result, onCommit } = setup();
        const preventDefault = vi.fn();
        act(() => {
            result.current.handleProps.onKeyDown({
                key: "ArrowLeft",
                shiftKey: false,
                preventDefault,
            } as never);
        });
        assert.equal(result.current.width, 316);
        assert.equal(preventDefault.mock.calls.length, 1, "arrow keys must not scroll");
        act(() => {
            result.current.handleProps.onKeyDown({
                key: "ArrowRight",
                shiftKey: false,
                preventDefault,
            } as never);
        });
        assert.equal(result.current.width, 300);
        assert.equal(onCommit.mock.calls.length, 2, "keyboard commits each step");
    });

    it("Shift multiplies the keyboard step", () => {
        const { result } = setup();
        act(() => {
            result.current.handleProps.onKeyDown({
                key: "ArrowLeft",
                shiftKey: true,
                preventDefault: vi.fn(),
            } as never);
        });
        assert.equal(result.current.width, 364);
    });

    it("ignores unrelated keys", () => {
        const { result, onCommit } = setup();
        act(() => {
            result.current.handleProps.onKeyDown({
                key: "Enter",
                shiftKey: false,
                preventDefault: vi.fn(),
            } as never);
        });
        assert.equal(result.current.width, 300);
        assert.equal(onCommit.mock.calls.length, 0);
    });

    it("double-click resets to the initial width", () => {
        const { result, onCommit } = setup();
        drag(result.current.handleProps, 800, 600);
        assert.equal(result.current.width, 500);
        act(() => {
            result.current.handleProps.onDoubleClick();
        });
        assert.equal(result.current.width, 300);
        assert.equal(onCommit.mock.calls.at(-1)?.[0], 300);
    });

    it("re-clamps on window resize without overwriting the stored preference", () => {
        // Bound tightens to 360 after the "resize"; the persisted 600 must not
        // be rewritten, so widening the window can restore it.
        let upper = 640;
        const shrinking = (raw: number) => Math.round(Math.max(220, Math.min(upper, raw)));
        const onCommit = vi.fn();
        const { result } = renderHook(() =>
            useDragResize({ initial: 600, min: 220, max: 640, clamp: shrinking, onCommit }),
        );
        assert.equal(result.current.width, 600);
        onCommit.mockClear();

        upper = 360;
        act(() => {
            window.dispatchEvent(new Event("resize"));
        });
        assert.equal(result.current.width, 360, "rendered width follows the tighter bound");
        assert.equal(onCommit.mock.calls.length, 0, "shrink must not persist");
    });

    it("re-clamps when the clamp identity changes without a resize event", () => {
        // Mirrors the sidebar collapsing: the bound moves but no resize fires.
        const onCommit = vi.fn();
        const { result, rerender } = renderHook(
            ({ upper }: { upper: number }) =>
                useDragResize({
                    initial: 600,
                    min: 220,
                    max: 640,
                    clamp: (raw: number) => Math.round(Math.max(220, Math.min(upper, raw))),
                    onCommit,
                }),
            { initialProps: { upper: 640 } },
        );
        assert.equal(result.current.width, 600);

        rerender({ upper: 400 });
        assert.equal(result.current.width, 400);
    });

    it("exposes the current width through the separator's aria values", () => {
        const { result } = setup();
        assert.equal(result.current.handleProps.role, "separator");
        assert.equal(result.current.handleProps["aria-orientation"], "vertical");
        assert.equal(result.current.handleProps["aria-valuenow"], 300);
        assert.equal(result.current.handleProps["aria-valuemin"], 220);
        assert.equal(result.current.handleProps["aria-valuemax"], 640);

        drag(result.current.handleProps, 800, 700);
        assert.equal(result.current.handleProps["aria-valuenow"], 400);
    });
});
