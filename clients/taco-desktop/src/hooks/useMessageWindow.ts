import type { RefObject } from "react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { turnStartAtOrBefore, type UiMessage } from "../lib/chat/chatUtils";

/** Rows mounted on open and added per "show earlier" click, before snapping to a turn start. */
const WINDOW_STEP = 40;

/** How long the expand keeps compensating for rows above the viewport that finish rendering late. */
const ANCHOR_HOLD_MS = 2000;

/**
 * Render only the tail of a long conversation, expanding toward older rows on
 * demand.
 *
 * Every assistant row runs the remark → shiki pipeline on mount, so opening a
 * long session used to block the main thread for seconds. The window starts
 * `WINDOW_STEP` rows from the end, snapped back to a turn start, and resets
 * when `sessionId` changes. The start index stays fixed while new rows append,
 * so streaming never unmounts rows above the viewport.
 *
 * Expanding keeps the viewport on the same content: markdown resolves after
 * mount and grows the new rows, so the distance from the bottom is re-pinned on
 * each DOM mutation until the user scrolls or `ANCHOR_HOLD_MS` passes.
 */
export function useMessageWindow(
    messages: readonly UiMessage[],
    sessionId: string | undefined,
    scrollRef: RefObject<HTMLElement | null>,
): { start: number; showEarlier: () => void } {
    const [state, setState] = useState(() => ({
        sessionId,
        start: initialStart(messages),
        seeded: messages.length > 0,
    }));
    // Re-seed during render (not in an effect) so the first paint of a newly
    // attached session already uses its own window. `seeded` covers a session
    // whose rows arrive after it became active.
    let current = state;
    if (state.sessionId !== sessionId || (!state.seeded && messages.length > 0)) {
        current = { sessionId, start: initialStart(messages), seeded: messages.length > 0 };
        setState(current);
    }
    const start = Math.min(current.start, messages.length);

    const pendingAnchor = useRef<number | null>(null);
    const showEarlier = useCallback(() => {
        const el = scrollRef.current;
        if (el) pendingAnchor.current = el.scrollHeight - el.scrollTop;
        setState((s) => ({
            ...s,
            start: turnStartAtOrBefore(messages, s.start - WINDOW_STEP),
        }));
    }, [messages, scrollRef]);

    // biome-ignore lint/correctness/useExhaustiveDependencies: start is the trigger — the anchor applies once the expanded rows are in the DOM.
    useLayoutEffect(() => {
        const el = scrollRef.current;
        const fromBottom = pendingAnchor.current;
        pendingAnchor.current = null;
        if (!el || fromBottom === null) return;
        const pin = (): void => {
            el.scrollTop = el.scrollHeight - fromBottom;
        };
        pin();
        const mo = new MutationObserver(pin);
        mo.observe(el, { childList: true, subtree: true });
        const release = (): void => {
            mo.disconnect();
            clearTimeout(timer);
            for (const type of USER_SCROLL_EVENTS) el.removeEventListener(type, release);
        };
        const timer = setTimeout(release, ANCHOR_HOLD_MS);
        for (const type of USER_SCROLL_EVENTS) {
            el.addEventListener(type, release, { passive: true });
        }
        return release;
    }, [start, scrollRef]);

    return { start, showEarlier };
}

// Input events rather than `scroll`: the pin itself fires scroll events.
const USER_SCROLL_EVENTS = ["wheel", "touchstart", "keydown", "pointerdown"] as const;

function initialStart(messages: readonly UiMessage[]): number {
    if (messages.length <= WINDOW_STEP) return 0;
    return turnStartAtOrBefore(messages, messages.length - WINDOW_STEP);
}
