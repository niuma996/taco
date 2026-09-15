/**
 * useDragResize — pointer-driven width for a right-anchored panel.
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

/** Keyboard step; Shift multiplies it for coarse adjustment. */
const KEY_STEP = 16;
const KEY_STEP_FAST = 64;

export function useDragResize({
    initial,
    min,
    max,
    clamp,
    onCommit,
}: {
    initial: number;
    min: number;
    max: number;
    /** Applied to every candidate value; owns the viewport-aware upper bound. */
    clamp: (raw: number) => number;
    onCommit: (width: number) => void;
}): { width: number; handleProps: DragHandleProps; reset: () => void } {
    const [width, setWidth] = useState(() => clamp(initial));
    // Mirrors `width` for synchronous reads inside closures (onPointerDown's
    // drag handlers, onKeyDown) without pulling `width` into their deps.
    const widthRef = useRef(width);
    widthRef.current = width;

    const commit = useCallback(
        (next: number) => {
            const clamped = clamp(next);
            setWidth(clamped);
            widthRef.current = clamped;
            onCommit(clamped);
        },
        [clamp, onCommit],
    );

    const onPointerDown = useCallback(
        (e: React.PointerEvent) => {
            const startX = e.clientX;
            const startWidth = widthRef.current;
            document.body.style.setProperty("user-select", "none");
            document.body.style.setProperty("cursor", "col-resize");

            const onMove = (ev: PointerEvent) => {
                // Panel is right-anchored: moving the pointer left must widen it.
                const next = clamp(startWidth + (startX - ev.clientX));
                setWidth(next);
                widthRef.current = next;
            };

            const stop = () => {
                window.removeEventListener("pointermove", onMove);
                window.removeEventListener("pointerup", stop);
                window.removeEventListener("pointercancel", stop);
                window.removeEventListener("blur", stop);
                document.body.style.removeProperty("user-select");
                document.body.style.removeProperty("cursor");
                onCommit(widthRef.current);
            };

            window.addEventListener("pointermove", onMove);
            window.addEventListener("pointerup", stop);
            window.addEventListener("pointercancel", stop);
            window.addEventListener("blur", stop);
        },
        [clamp, onCommit],
    );

    const reset = useCallback(() => commit(initial), [commit, initial]);

    const onKeyDown = useCallback(
        (e: React.KeyboardEvent) => {
            const step = e.shiftKey ? KEY_STEP_FAST : KEY_STEP;
            if (e.key === "ArrowLeft") {
                e.preventDefault();
                commit(widthRef.current + step);
            } else if (e.key === "ArrowRight") {
                e.preventDefault();
                commit(widthRef.current - step);
            }
        },
        [commit],
    );

    return {
        width,
        reset,
        handleProps: {
            role: "separator",
            "aria-orientation": "vertical",
            "aria-valuenow": width,
            "aria-valuemin": min,
            "aria-valuemax": max,
            tabIndex: 0,
            onPointerDown,
            onDoubleClick: reset,
            onKeyDown,
        },
    };
}
