import type { RefObject } from "react";
import { useCallback, useLayoutEffect, useRef } from "react";

const NEAR_BOTTOM_PX = 80;

/** A scroll this soon after wheel / touch / key / scrollbar input counts as the user's. */
const USER_INPUT_WINDOW_MS = 250;

/** Keys that scroll a focused container upward. */
const UPWARD_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);

/**
 * Keep a scroll container pinned to its bottom while content grows, unless the
 * user has scrolled up away from it. Snaps to the bottom on mount and whenever
 * `resetKey` changes, before the browser paints — a newly shown conversation
 * never flashes its top first.
 *
 * The observers attach to the element itself, so the caller must keep the ref
 * on a node that unmounts with it — forwarding a ref from a never-unmounting
 * parent leaves the observers on a detached node after a conditional re-render.
 *
 * `resetKey` re-runs the setup — pass whatever changes when the element is
 * swapped in or its content is replaced wholesale (a panel opening, another
 * session selected), so the new content starts pinned again.
 *
 * Only an upward move the user made unpins. Judging by distance-from-bottom
 * alone raced streaming (a scroll event dispatched after content grew read as
 * "scrolled away"), and judging by direction alone let layout unpin: content
 * collapsing above the viewport, or another hook restoring a scroll position,
 * moves scrollTop up with no user involved. So an upward scroll unpins only
 * within a short window after wheel, touch, upward-key or scrollbar input.
 *
 * Growth is caught from both sides: a MutationObserver for DOM changes, and a
 * ResizeObserver on the container and its direct children for height changes
 * no mutation reports (an image finishing loading, a font swap, a reflow).
 *
 * Returns `pin`, which re-sticks and snaps immediately — for callers that know
 * the user wants the bottom regardless of where they were (just sent a message)
 * — and `unpin`, which stops the follow without any user input, for callers
 * that take over the scroll position themselves.
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
            if (distance <= 1) stick = true;
            else if (top < lastTop) {
                if (userActive()) stick = false;
            } else if (distance <= NEAR_BOTTOM_PX) stick = true;
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
            }
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
            snap();
        };
        // Explicit unpin: no user input involved, so the follow has to stop
        // on request. The queued follow is cancelled too, or it would snap
        // once more before the caller could take over the scroll position.
        unpinRef.current = () => {
            stick = false;
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
