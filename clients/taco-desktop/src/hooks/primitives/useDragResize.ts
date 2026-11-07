/**
 * useDragResize — pointer-driven resize for a right-anchored panel, working
 * in the caller's value units (`pixelsPerUnit` scales a pointer delta).
 * `requested` is what the user asked for and is persisted; the exposed width
 * is `clamp(requested)`, derived while rendering — unclamped by the
 * layout-aware bound, so a preference survives a temporary squeeze.
 *
 * Listeners attach on pointerdown and are removed by `stop`, so no effect
 * re-runs for the latest `clamp` / `onCommit`. pointercancel / blur are
 * handled too, or a pointer released outside the window leaves the body
 * stuck with a resize cursor.
 */
import { useCallback, useRef, useState } from "react";

import { applyWithoutTransition, holdTransitionSuppressed } from "./resizeTransition";

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

export function useDragResize({
    initial,
    min,
    max,
    clamp,
    pixelsPerUnit = 1,
    step = 16,
    stepFast = 64,
    ariaValue = (value) => value,
    ariaMin,
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
    /**
     * Reachable lower bound to announce, when it is narrower than `min`.
     * The hard bound can be wider than anything the layout allows — a share
     * whose floor is 30% of the chat area, say — and announcing a range the
     * user cannot reach is a lie to a screen reader.
     */
    ariaMin?: number;
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
            const release = holdTransitionSuppressed();

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
                release();
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
                // The width lands at once: animating it makes the panel crawl
                // behind the key press. The drag path suppresses the
                // transition for the whole gesture instead.
                applyWithoutTransition(() => commit(widthRef.current + delta));
            } else if (e.key === "ArrowRight") {
                e.preventDefault();
                applyWithoutTransition(() => commit(widthRef.current - delta));
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
            "aria-valuemin": ariaValue(ariaMin ?? min),
            "aria-valuemax": ariaValue(max),
            tabIndex: 0,
            onPointerDown,
            onDoubleClick: reset,
            onKeyDown,
        },
    };
}
