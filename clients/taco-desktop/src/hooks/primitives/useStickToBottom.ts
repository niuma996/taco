import type { RefObject } from "react";
import { useCallback, useLayoutEffect, useRef } from "react";

const NEAR_BOTTOM_PX = 80;

/** A scroll this soon after wheel / touch / key / scrollbar input counts as the user's. */
const USER_INPUT_WINDOW_MS = 250;

/** Keys that scroll a focused container upward. */
const UPWARD_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);

/** Keys that scroll a focused container downward. */
const DOWNWARD_KEYS = new Set(["ArrowDown", "PageDown", "End", " ", "Spacebar"]);

/**
 * Keep a scroll container pinned to its bottom while content grows, unless the
 * user has scrolled up away from it. Snaps to the bottom on mount and whenever
 * `resetKey` changes, before the browser paints.
 *
 * The observers attach to the element itself, so the caller must keep the ref
 * on a node that unmounts with it — a forwarded ref from a never-unmounting
 * parent leaves the observers on a detached node after a conditional re-render.
 *
 * The follow re-arms near the bottom (at it, or within 80px) and drops only on
 * an upward move the user made — within a short window of a wheel, touch,
 * upward-key or scrollbar input.
 *
 * `pin` re-sticks and snaps immediately, clearing the unpin. `unpin` stops the
 * follow with no user input and outranks the near-bottom heuristic: the jump
 * sets scrollTop and the browser dispatches a scroll for it, which must not
 * re-arm the follow.
 */
export function useStickToBottom(
    ref: RefObject<HTMLElement | null>,
    resetKey?: unknown,
): { pin: () => void; unpin: () => void } {
    const pinRef = useRef<() => void>(() => {});
    const unpinRef = useRef<() => void>(() => {});

    // biome-ignore lint/correctness/useExhaustiveDependencies: resetKey is the trigger only; it is not read inside the effect.
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        let rafId: number | null = null;
        let stick = true;
        // An explicit unpin outranks the proximity heuristic: the caller took
        // over the scroll position, so no scroll event may re-arm the follow.
        let explicitlyUnpinned = false;
        let lastUserInputAt = Number.NEGATIVE_INFINITY;
        let draggingScrollbar = false;

        const snap = (): void => {
            el.scrollTo({ top: el.scrollHeight });
            lastTop = el.scrollTop;
        };
        let lastTop = 0;
        snap();

        const userActive = (): boolean =>
            draggingScrollbar || performance.now() - lastUserInputAt < USER_INPUT_WINDOW_MS;

        const onScroll = (): void => {
            const top = el.scrollTop;
            const distance = el.scrollHeight - top - el.clientHeight;
            // At the very bottom first: content shrinking clamps scrollTop
            // down, which must not read as the user scrolling up.
            if (distance <= 1) {
                if (explicitlyUnpinned) {
                    // The user came back to the bottom on their own: the
                    // follow is armed again. A programmatic scroll must not
                    // re-arm it, so the user input decides.
                    if (userActive()) {
                        explicitlyUnpinned = false;
                        stick = true;
                    }
                } else {
                    stick = true;
                }
            } else if (top < lastTop) {
                if (userActive()) stick = false;
            } else if (distance <= NEAR_BOTTOM_PX) {
                if (!explicitlyUnpinned) stick = true;
            }
            lastTop = top;
        };
        const markInput = (): void => {
            lastUserInputAt = performance.now();
        };
        const onWheel = (e: WheelEvent): void => {
            markInput();
            // Unpin on the gesture itself: at the bottom, the first notch can
            // land before the scroll it causes, and the follow-up snap would
            // otherwise eat it.
            if (e.deltaY < 0) stick = false;
        };
        const onKeyDown = (e: KeyboardEvent): void => {
            if (UPWARD_KEYS.has(e.key)) {
                markInput();
                stick = false;
                return;
            }
            // A downward key is user activity too: it must be able to bring
            // the follow back.
            if (DOWNWARD_KEYS.has(e.key)) markInput();
        };
        // Content covers the container, so a pointerdown whose target is the
        // container itself is on its scrollbar.
        const onPointerDown = (e: PointerEvent): void => {
            if (e.target !== el) return;
            draggingScrollbar = true;
            markInput();
        };
        const onPointerUp = (): void => {
            if (!draggingScrollbar) return;
            draggingScrollbar = false;
            markInput();
        };

        el.addEventListener("scroll", onScroll, { passive: true });
        el.addEventListener("wheel", onWheel, { passive: true });
        el.addEventListener("touchmove", markInput, { passive: true });
        el.addEventListener("keydown", onKeyDown);
        el.addEventListener("pointerdown", onPointerDown);
        window.addEventListener("pointerup", onPointerUp);
        window.addEventListener("pointercancel", onPointerUp);

        const schedule = (): void => {
            if (!stick) return;
            if (rafId !== null) return;
            rafId = requestAnimationFrame(() => {
                rafId = null;
                if (stick) snap();
            });
        };
        const ro = new ResizeObserver(schedule);
        ro.observe(el);
        const observeChildren = (): void => {
            // observe() on an already-observed node is a no-op, and removed
            // nodes drop out of a ResizeObserver on their own.
            for (const child of el.children) ro.observe(child);
        };
        observeChildren();
        const mo = new MutationObserver(() => {
            observeChildren();
            schedule();
        });
        mo.observe(el, { childList: true, subtree: true, characterData: true });

        pinRef.current = () => {
            stick = true;
            explicitlyUnpinned = false;
            snap();
        };
        // Explicit unpin: no user input involved, so the follow has to stop
        // on request. The queued follow is cancelled too, or it would snap
        // once more before the caller could take over the scroll position.
        unpinRef.current = () => {
            stick = false;
            explicitlyUnpinned = true;
            if (rafId !== null) {
                cancelAnimationFrame(rafId);
                rafId = null;
            }
        };

        return () => {
            el.removeEventListener("scroll", onScroll);
            el.removeEventListener("wheel", onWheel);
            el.removeEventListener("touchmove", markInput);
            el.removeEventListener("keydown", onKeyDown);
            el.removeEventListener("pointerdown", onPointerDown);
            window.removeEventListener("pointerup", onPointerUp);
            window.removeEventListener("pointercancel", onPointerUp);
            mo.disconnect();
            ro.disconnect();
            if (rafId !== null) cancelAnimationFrame(rafId);
            pinRef.current = () => {};
            unpinRef.current = () => {};
        };
    }, [ref, resetKey]);

    const pin = useCallback(() => pinRef.current(), []);
    const unpin = useCallback(() => unpinRef.current(), []);
    return { pin, unpin };
}
