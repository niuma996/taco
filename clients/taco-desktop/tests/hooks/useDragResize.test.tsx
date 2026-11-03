import { strict as assert } from "node:assert";
import { act, renderHook } from "@testing-library/react";
import { describe, it, vi } from "vitest";

import { useDragResize } from "../../src/hooks/primitives/useDragResize";

/** Clamp to [0.2, 0.5] — a share of the chat area, layout aside. */
const clamp = (raw: number) => Math.min(0.5, Math.max(0.2, raw));

function setup(overrides: Partial<Parameters<typeof useDragResize>[0]> = {}, onCommit = vi.fn()) {
    const { result } = renderHook(() =>
        useDragResize({
            initial: 0.3,
            min: 0,
            max: 0.5,
            clamp,
            pixelsPerUnit: 1000,
            step: 0.02,
            stepFast: 0.05,
            ariaValue: (value) => Math.round(value * 100),
            resetTo: 0.3,
            onCommit,
            ...overrides,
        }),
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
    it("clamps the initial value instead of trusting it", () => {
        const { result } = setup({ initial: 0.9 });
        assert.equal(result.current.width, 0.5);
    });

    it("dragging left widens the right-anchored panel", () => {
        const { result, onCommit } = setup();
        // Pointer moves left by 100px → the share grows by 100/1000.
        drag(result.current.handleProps, 800, 700);
        assert.equal(result.current.width, 0.4);
        assert.equal(onCommit.mock.calls.at(-1)?.[0], 0.4);
    });

    it("the drag delta scales with pixelsPerUnit", () => {
        const { result } = setup({ pixelsPerUnit: 2000 });
        // Same 100px of travel, but a unit now spans 2000px.
        drag(result.current.handleProps, 800, 700);
        assert.equal(result.current.width, 0.35);
    });

    it("dragging right narrows the panel and clamps at the lower bound", () => {
        const { result } = setup();
        drag(result.current.handleProps, 800, 1000);
        assert.equal(result.current.width, 0.2);
    });

    it("commits the request, not the clamped value", () => {
        const { result, onCommit } = setup();
        // Drag below the rendered floor: the request survives, the render does not.
        drag(result.current.handleProps, 800, 1000);
        assert.equal(result.current.width, 0.2);
        const committed = onCommit.mock.calls.at(-1)?.[0] as number;
        assert.ok(Math.abs(committed - 0.1) < 1e-9, `expected ~0.1, got ${committed}`);
    });

    it("commits the final value once on release, not per move", () => {
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
        assert.equal(onCommit.mock.calls[0]?.[0], 0.4);
    });

    it("marks the body while a drag is live", () => {
        const { result } = setup();
        act(() => {
            result.current.handleProps.onPointerDown({ clientX: 800 } as never);
        });
        assert.equal(document.body.getAttribute("data-panel-resizing"), "true");
        act(() => {
            window.dispatchEvent(new MouseEvent("pointerup"));
        });
        assert.equal(document.body.hasAttribute("data-panel-resizing"), false);
    });

    it("suppresses the width transition for a keyboard step, then releases it", async () => {
        const { result } = setup();
        act(() => {
            result.current.handleProps.onKeyDown({
                key: "ArrowLeft",
                shiftKey: false,
                preventDefault: vi.fn(),
            } as never);
        });
        // The mark must be in place while the new width is laid out, or the
        // transition would animate and the panel would lag the key press.
        assert.equal(document.body.getAttribute("data-panel-resizing"), "true");

        // Released on the next frame, once the width has been laid out.
        await act(async () => {
            await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
        });
        assert.equal(document.body.hasAttribute("data-panel-resizing"), false);
    });

    it("keeps the mark across a burst of key presses", async () => {
        const { result } = setup();
        for (let i = 0; i < 3; i++) {
            act(() => {
                result.current.handleProps.onKeyDown({
                    key: "ArrowLeft",
                    shiftKey: false,
                    preventDefault: vi.fn(),
                } as never);
            });
        }
        // Every press re-arms the mark, so it is still held here.
        assert.equal(document.body.getAttribute("data-panel-resizing"), "true");

        await act(async () => {
            await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
        });
        assert.equal(document.body.hasAttribute("data-panel-resizing"), false);
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
            window.dispatchEvent(new MouseEvent("pointercancel"));
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
        assert.equal(result.current.width, 0.32);
        assert.equal(preventDefault.mock.calls.length, 1, "arrow keys must not scroll");
        act(() => {
            result.current.handleProps.onKeyDown({
                key: "ArrowRight",
                shiftKey: false,
                preventDefault,
            } as never);
        });
        assert.equal(result.current.width, 0.3);
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
        assert.equal(result.current.width, 0.35);
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
        assert.equal(result.current.width, 0.3);
        assert.equal(onCommit.mock.calls.length, 0);
    });

    it("double-click resets to the reset target", () => {
        const { result, onCommit } = setup();
        drag(result.current.handleProps, 800, 600);
        assert.equal(result.current.width, 0.5);
        act(() => {
            result.current.handleProps.onDoubleClick();
        });
        assert.equal(result.current.width, 0.3);
        assert.equal(onCommit.mock.calls.at(-1)?.[0], 0.3);
    });

    it("re-clamps as soon as the bound tightens", () => {
        // Mirrors the sidebar collapsing: the bound moves and the value follows
        // on the next render, with no resize event involved.
        const onCommit = vi.fn();
        const { result, rerender } = renderHook(
            ({ upper }: { upper: number }) =>
                useDragResize({
                    initial: 0.4,
                    min: 0,
                    max: 0.5,
                    clamp: (raw: number) => Math.min(upper, Math.max(0.2, raw)),
                    pixelsPerUnit: 1000,
                    onCommit,
                }),
            { initialProps: { upper: 0.5 } },
        );
        assert.equal(result.current.width, 0.4);

        rerender({ upper: 0.3 });
        assert.equal(result.current.width, 0.3);
        assert.equal(onCommit.mock.calls.length, 0, "a tighter bound must not persist");
    });

    it("exposes the current value through the separator's aria values", () => {
        const { result } = setup();
        assert.equal(result.current.handleProps.role, "separator");
        assert.equal(result.current.handleProps["aria-orientation"], "vertical");
        assert.equal(result.current.handleProps["aria-valuenow"], 30);
        assert.equal(result.current.handleProps["aria-valuemin"], 0);
        assert.equal(result.current.handleProps["aria-valuemax"], 50);

        drag(result.current.handleProps, 800, 700);
        assert.equal(result.current.handleProps["aria-valuenow"], 40);
    });
});
