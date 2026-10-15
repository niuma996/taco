import type { RefObject } from "react";
import { useEffect } from "react";

const NEAR_BOTTOM_PX = 80;

/**
 * Keep a scroll container pinned to its bottom while content grows, unless the
 * user has scrolled up away from it. Snaps to the bottom once on mount.
 *
 * The observers attach to the element itself, so the caller must keep the ref
 * on a node that unmounts with it — forwarding a ref from a never-unmounting
 * parent leaves the observers on a detached node after a conditional re-render.
 *
 * `resetKey` re-runs the setup — pass whatever changes when the element is
 * swapped in or its content is replaced wholesale (a panel opening, another
 * item selected), so the new content starts pinned again.
 *
 * Only an upward move unpins. Judging by distance-from-bottom alone raced
 * streaming: a scroll event dispatched after content grew but before the
 * catch-up scroll ran measured the new content as "user scrolled away" and
 * unpinned for good. Growth never lowers scrollTop, so direction is immune.
 */
export function useStickToBottom(ref: RefObject<HTMLElement | null>, resetKey?: unknown): void {
    // biome-ignore lint/correctness/useExhaustiveDependencies: resetKey is the trigger only; it is not read inside the effect.
    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        el.scrollTo({ top: 1e9 });
        let rafId: number | null = null;
        let stick = true;
        let lastTop = el.scrollTop;
        const onScroll = (): void => {
            const top = el.scrollTop;
            const distance = el.scrollHeight - top - el.clientHeight;
            // At the very bottom first: content shrinking clamps scrollTop
            // down, which must not read as the user scrolling up.
            if (distance <= 1) stick = true;
            else if (top < lastTop) stick = false;
            else if (distance <= NEAR_BOTTOM_PX) stick = true;
            lastTop = top;
        };
        el.addEventListener("scroll", onScroll, { passive: true });
        const schedule = (): void => {
            if (!stick) return;
            if (rafId !== null) return;
            rafId = requestAnimationFrame(() => {
                rafId = null;
                if (!stick) return;
                el.scrollTo({ top: el.scrollHeight });
            });
        };
        const mo = new MutationObserver(schedule);
        mo.observe(el, { childList: true, subtree: true, characterData: true });
        const ro = new ResizeObserver(schedule);
        ro.observe(el);
        return () => {
            el.removeEventListener("scroll", onScroll);
            mo.disconnect();
            ro.disconnect();
            if (rafId !== null) cancelAnimationFrame(rafId);
        };
    }, [ref, resetKey]);
}
