/**
 * useDragResize — pointer-driven resize for a right-anchored panel.
 *
 * The value domain belongs to the caller: the hook works in "units" and only
 * needs to know how many pixels one unit spans (`pixelsPerUnit`) to turn a
 * pointer delta into a value delta. A pixel width passes 1; a share of the
 * chat area passes the chat area's width.
 *
 * Two values, deliberately. `requested` is what the user asked for and is
 * what gets persisted; the exposed width is `clamp(requested)`, derived while
 * rendering. Keeping the request unclamped by the layout-aware bound is what
 * lets a preference survive a temporary squeeze — a 50% panel squeezed to
 * the 250px floor on a narrow window comes back in full when the room
 * returns. The caller's `clamp` therefore owns the layout-aware bound, and the
 * caller must re-render when that bound moves.
 *
 * Dragging left widens the panel, so the delta is inverted. Listeners are
 * attached on pointerdown and removed by `stop`, rather than living in an
 * effect: window listeners with no cleanup dependency would otherwise need
 * an effect that re-runs every render just to read the latest `clamp` /
 * `onCommit`, which is both harder to reason about and trips
 * `useExhaustiveDependencies`. Attaching inline reads the current closures
 * directly and needs no dependency array at all. Include pointercancel /
 * blur alongside pointerup: without them a pointer released outside the
 * window would leave the body stuck with a resize cursor and text selection
 * disabled.
 */
import { useCallback, useRef, useState } from "react";

export interface DragHandleProps {
    role: "separator";
    "aria-orientation": "vertical";
    "aria-valuenow": number;
    "aria-valuemin": number;
    "aria-valuemax": number;
    tabIndex: 0;
    onPointerDown: (e: React.PointerEvent) => void;
    onDoubleClick: () => void;
    onKeyDown: (e: React.KeyboardEvent) => void;
}

/** Marks the body while a drag is live so CSS can drop panel transitions. */
const RESIZING_ATTRIBUTE = "data-panel-resizing";

export function useDragResize({
    initial,
    min,
    max,
    clamp,
    pixelsPerUnit = 1,
    step = 16,
    stepFast = 64,
    ariaValue = (value) => value,
    resetTo,
    onCommit,
}: {
    initial: number;
    /** Hard lower bound of the requested value. */
    min: number;
    /** Hard upper bound of the requested value. */
    max: number;
    /** Applied to the request while rendering; owns the layout-aware bound. */
    clamp: (raw: number) => number;
    /** Pixels per unit of the value domain — a share's base width. */
    pixelsPerUnit?: number;
    /** Keyboard step, in value units. */
    step?: number;
    /** Keyboard step with Shift held. */
    stepFast?: number;
    /** Formats the exposed aria values (a share as a percentage, say). */
    ariaValue?: (value: number) => number;
    /** Double-click target; defaults to `initial`. */
    resetTo?: number;
    /** Receives the user's request, not the clamped value. */
    onCommit: (value: number) => void;
}): { width: number; handleProps: DragHandleProps; reset: () => void } {
    const [requested, setRequested] = useState(initial);
    // Mirrors the request for synchronous reads inside closures (the drag
    // handlers, onKeyDown) without pulling it into their deps.
    const requestedRef = useRef(requested);
    requestedRef.current = requested;

    // Derived, not stored: the bound moves with the layout (window resize,
    // sidebar collapse), so clamping on every render keeps the value and the
    // bound in step without an effect that lags a frame behind the layout.
    const width = clamp(requested);
    const widthRef = useRef(width);
    widthRef.current = width;

    // The reset target is fixed at mount: the caller's `initial` may follow
    // the persisted preference, and a reset that followed it would be a no-op.
    const resetTarget = useRef(resetTo ?? initial).current;

    const hardClamp = useCallback(
        (value: number) => Math.min(max, Math.max(min, value)),
        [max, min],
    );

    const commit = useCallback(
        (next: number) => {
            const bounded = hardClamp(next);
            setRequested(bounded);
            requestedRef.current = bounded;
            onCommit(bounded);
        },
        [hardClamp, onCommit],
    );

    const onPointerDown = useCallback(
        (e: React.PointerEvent) => {
            const startX = e.clientX;
            const startValue = widthRef.current;
            const unit = Math.max(1, pixelsPerUnit);
            document.body.style.setProperty("user-select", "none");
            document.body.style.setProperty("cursor", "col-resize");
            document.body.setAttribute(RESIZING_ATTRIBUTE, "true");

            const onMove = (ev: PointerEvent) => {
                // Panel is right-anchored: moving the pointer left must widen it.
                const next = hardClamp(startValue + (startX - ev.clientX) / unit);
                setRequested(next);
                requestedRef.current = next;
            };

            const stop = () => {
                window.removeEventListener("pointermove", onMove);
                window.removeEventListener("pointerup", stop);
                window.removeEventListener("pointercancel", stop);
                window.removeEventListener("blur", stop);
                document.body.style.removeProperty("user-select");
                document.body.style.removeProperty("cursor");
                document.body.removeAttribute(RESIZING_ATTRIBUTE);
                onCommit(requestedRef.current);
            };

            window.addEventListener("pointermove", onMove);
            window.addEventListener("pointerup", stop);
            window.addEventListener("pointercancel", stop);
            window.addEventListener("blur", stop);
        },
        [hardClamp, onCommit, pixelsPerUnit],
    );

    const reset = useCallback(() => commit(resetTarget), [commit, resetTarget]);

    const onKeyDown = useCallback(
        (e: React.KeyboardEvent) => {
            const delta = e.shiftKey ? stepFast : step;
            if (e.key === "ArrowLeft") {
                e.preventDefault();
                commit(widthRef.current + delta);
            } else if (e.key === "ArrowRight") {
                e.preventDefault();
                commit(widthRef.current - delta);
            }
        },
        [commit, step, stepFast],
    );

    return {
        width,
        reset,
        handleProps: {
            role: "separator",
            "aria-orientation": "vertical",
            "aria-valuenow": ariaValue(width),
            "aria-valuemin": ariaValue(min),
            "aria-valuemax": ariaValue(max),
            tabIndex: 0,
            onPointerDown,
            onDoubleClick: reset,
            onKeyDown,
        },
    };
}
