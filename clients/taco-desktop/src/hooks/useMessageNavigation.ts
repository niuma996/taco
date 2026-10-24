/**
 * useMessageNavigation — jump the chat to a user message picked in the guide.
 *
 * The guide indexes every user message of the session, including rows the
 * render window has not mounted, so a jump has two shapes: the target is
 * already on screen, or it still has to be revealed. This hook owns both. It
 * releases the bottom follow, reveals the target when the window does not
 * cover it, scrolls it into the middle of the viewport and keeps it there
 * while the revealed rows finish rendering.
 *
 * Two positions come out of it. `activeId` is the message the chat is
 * showing: it follows the scroll position, but a jump holds it, so the guide
 * does not walk through every row a smooth scroll passes. `highlightedId` is
 * the message the last jump landed on.
 *
 * The user always wins — wheel, touch, an upward key or a scrollbar grab
 * ends the jump, its correction and the hold together.
 */

import type { RefObject } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { UserMessageGuideEntry } from "../lib/chat/userMessageGuide";

/** How long a revealed target keeps re-centering while its content grows. */
const CORRECTION_HOLD_MS = 2000;

/** Quiet period after the last scroll report that ends a jump's hold. */
const SETTLE_MS = 150;

/** Idle backstop: a jump whose scroll is never reported ends after this. */
const HOLD_MAX_MS = 1000;

/** Keys that scroll the container. */
const SCROLL_KEYS = new Set([
    "ArrowUp",
    "ArrowDown",
    "PageUp",
    "PageDown",
    "Home",
    "End",
    " ",
    "Spacebar",
]);

export interface MessageNavigationOptions {
    /** The chat's scroll container — the element the message rows live in. */
    scrollRef: RefObject<HTMLElement | null>;
    /** Active session. A change discards every pending jump. */
    sessionId: string | undefined;
    /** Index of the first mounted message row. */
    windowStart: number;
    /** Whether the chat is showing a conversation at all. */
    enabled: boolean;
    /** Reveal a message the render window has not mounted. */
    revealTo: (index: number) => void;
    /** Stop the bottom follow — the jump owns the scroll position. */
    unpin: () => void;
}

export interface MessageNavigation {
    /** Id of the user message the chat is showing. */
    activeId?: string;
    /** Id of the user message the last jump landed on. */
    highlightedId?: string;
    /** Jump to the entry the user picked. */
    navigate: (entry: UserMessageGuideEntry) => void;
}

/** A jump in flight: it holds the current item and may correct the position. */
interface Jump {
    /** Jump counter this jump belongs to — only the newest one may act. */
    token: number;
    /** Ends the jump. `recompute` refreshes the current item afterwards. */
    end: (recompute: boolean) => void;
    /** Called on every scroll event while the jump is in flight. */
    keepAlive: () => void;
    /** Observers to disconnect when the jump ends. */
    observers: Set<{ disconnect: () => void }>;
}

/** The mounted user row carrying this id, if the window covers it. */
function findTarget(el: HTMLElement, id: string): HTMLElement | null {
    for (const node of el.querySelectorAll<HTMLElement>("[data-message-id]")) {
        if (node.dataset.messageId === id) return node;
    }
    return null;
}

/**
 * The message the viewport is showing: the last user row above the middle of
 * the container, or the nearest one below when nothing is above it.
 */
function currentMessageId(el: HTMLElement): string | undefined {
    const rect = el.getBoundingClientRect();
    const center = rect.top + rect.height / 2;
    let above: string | undefined;
    let below: string | undefined;
    for (const node of el.querySelectorAll<HTMLElement>("[data-message-id]")) {
        const id = node.dataset.messageId;
        if (!id) continue;
        if (node.getBoundingClientRect().top <= center) above = id;
        else if (below === undefined) below = id;
    }
    return above ?? below;
}

function scrollToTarget(node: HTMLElement, behavior: ScrollBehavior): void {
    node.scrollIntoView({ block: "center", behavior });
}

/**
 * Scroll behavior of a jump. The reduced-motion preference is read at jump
 * time, not when the hook was built: it can change while the app runs, and a
 * captured value would keep animating after the user asked for stillness.
 */
function jumpBehavior(): ScrollBehavior {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    return reduce ? "instant" : "smooth";
}

export function useMessageNavigation({
    scrollRef,
    sessionId,
    windowStart,
    enabled,
    revealTo,
    unpin,
}: MessageNavigationOptions): MessageNavigation {
    const [activeId, setActiveId] = useState<string | undefined>(undefined);
    const [highlightedId, setHighlightedId] = useState<string | undefined>(undefined);
    const [pending, setPending] = useState<UserMessageGuideEntry | null>(null);
    /** Session the pending jump belongs to — a switch must not fulfil it. */
    const pendingSessionRef = useRef<string | undefined>(undefined);
    /** Mirror of `pending` for the callbacks that cannot read state. */
    const pendingRef = useRef<UserMessageGuideEntry | null>(null);
    /** Monotonic jump counter: only the newest jump may act. */
    const tokenRef = useRef(0);
    /** The jump in flight, if any. */
    const jumpRef = useRef<Jump | null>(null);
    /** Frame scheduled for the current-item update. */
    const rafRef = useRef<number | null>(null);
    /** Whether a jump holds the current item against the scroll position. */
    const holdRef = useRef(false);
    /** Index of the first mounted row — a pending target's window. */
    const windowStartRef = useRef(windowStart);
    /** Window the pending jump started in: a window that never moved cannot
     * cover the target any more. */
    const pendingWindowStartRef = useRef<number | null>(null);

    useLayoutEffect(() => {
        windowStartRef.current = windowStart;
    }, [windowStart]);

    const updateCurrent = useCallback(() => {
        if (holdRef.current) return;
        const el = scrollRef.current;
        if (!el) return;
        const pending = pendingRef.current;
        if (pending) {
            // A pending target whose window never moved cannot be covered
            // any more: the session no longer has it. Left alone it would
            // freeze the current item for good.
            const stale =
                windowStartRef.current === pendingWindowStartRef.current &&
                !findTarget(el, pending.id);
            if (!stale) return;
            pendingRef.current = null;
            pendingSessionRef.current = undefined;
            pendingWindowStartRef.current = null;
            setPending(null);
        }
        const id = currentMessageId(el);
        if (id !== undefined) setActiveId(id);
    }, [scrollRef]);

    const scheduleUpdate = useCallback(() => {
        if (rafRef.current !== null) return;
        rafRef.current = window.requestAnimationFrame(() => {
            rafRef.current = null;
            updateCurrent();
        });
    }, [updateCurrent]);

    const cancelUpdate = useCallback(() => {
        if (rafRef.current === null) return;
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
    }, []);

    const endJump = useCallback((recompute: boolean) => {
        const jump = jumpRef.current;
        if (!jump) return;
        jumpRef.current = null;
        jump.end(recompute);
    }, []);

    /**
     * Start a jump: it holds the current item until the browser stops
     * reporting the scroll, or — for a revealed target — until the content
     * around it has settled.
     */
    const startJump = useCallback(
        (token: number, mode: "smooth" | "correction"): Jump => {
            endJump(true);
            const observers = new Set<{ disconnect: () => void }>();
            const timers = new Set<number>();
            let settleTimer: number | null = null;
            let deadlineTimer: number | null = null;
            let ended = false;

            const finish = (recompute: boolean): void => {
                if (ended) return;
                ended = true;
                // The jump is over, so it must leave the registry. A stale
                // entry would keep the scroll handler calling into it, which
                // both re-arms its timers and stops the current item from
                // following the scroll position.
                if (jumpRef.current?.token === token) jumpRef.current = null;
                if (settleTimer !== null) window.clearTimeout(settleTimer);
                if (deadlineTimer !== null) window.clearTimeout(deadlineTimer);
                for (const timer of timers) window.clearTimeout(timer);
                for (const observer of observers) observer.disconnect();
                holdRef.current = false;
                if (recompute) scheduleUpdate();
            };

            const keepAlive = (): void => {
                // Only an animated scroll reports its progress. A revealed
                // target holds for its own window, however long the content
                // around it takes to settle.
                if (mode !== "smooth") return;
                // Both deadlines are measured from the last report, so a jump
                // across a long conversation keeps its target for as long as
                // the animation runs.
                if (settleTimer !== null) window.clearTimeout(settleTimer);
                settleTimer = window.setTimeout(() => {
                    settleTimer = null;
                    finish(true);
                }, SETTLE_MS);
                if (deadlineTimer !== null) window.clearTimeout(deadlineTimer);
                deadlineTimer = window.setTimeout(() => {
                    deadlineTimer = null;
                    finish(true);
                }, HOLD_MAX_MS);
            };

            const jump: Jump = { token, end: finish, keepAlive, observers };
            jumpRef.current = jump;
            holdRef.current = true;
            if (mode === "smooth") {
                // The idle backstop covers a browser that reports no scroll
                // at all: without a report the settle timer never arms.
                deadlineTimer = window.setTimeout(() => {
                    deadlineTimer = null;
                    finish(true);
                }, HOLD_MAX_MS);
            } else {
                // A revealed target holds its place while its markdown and
                // images resolve.
                timers.add(window.setTimeout(() => finish(true), CORRECTION_HOLD_MS));
            }
            return jump;
        },
        [endJump, scheduleUpdate],
    );

    /**
     * Keep a revealed target in the middle of the viewport: its rows grow
     * while markdown and images resolve, and a box that grew without a
     * mutation still moves the target.
     *
     * Only the target's own box decides. A row elsewhere that streams must
     * not cost a query or a scroll, so the target is cached and its rect is
     * compared with the last one seen.
     */
    const startCorrection = useCallback(
        (jump: Jump, id: string) => {
            const container = scrollRef.current;
            if (!container) return;
            let node = findTarget(container, id);
            let lastTop = node ? node.getBoundingClientRect().top : 0;
            let lastHeight = node ? node.getBoundingClientRect().height : 0;

            const remember = (current: HTMLElement): void => {
                const rect = current.getBoundingClientRect();
                lastTop = rect.top;
                lastHeight = rect.height;
            };

            const recenter = (): void => {
                if (jump.token !== tokenRef.current) return;
                if (!node?.isConnected) {
                    // The row was replaced: take the new one.
                    node = findTarget(container, id);
                    if (!node) return;
                    ro.disconnect();
                    ro.observe(node);
                    remember(node);
                }
                const rect = node.getBoundingClientRect();
                if (rect.top === lastTop && rect.height === lastHeight) return;
                scrollToTarget(node, "instant");
                remember(node);
            };

            const ro = new ResizeObserver(recenter);
            const mo = new MutationObserver(recenter);
            mo.observe(container, { childList: true, subtree: true, characterData: true });
            jump.observers.add(mo);
            jump.observers.add(ro);
            if (node) ro.observe(node);
        },
        [scrollRef],
    );

    const navigate = useCallback(
        (entry: UserMessageGuideEntry) => {
            const token = ++tokenRef.current;
            unpin();
            setActiveId(entry.id);
            setHighlightedId(entry.id);
            const el = scrollRef.current;
            const node = el ? findTarget(el, entry.id) : undefined;
            if (!el || !node) {
                // The window does not cover the target: reveal it and wait for
                // the rows to appear.
                pendingRef.current = entry;
                pendingSessionRef.current = sessionId;
                pendingWindowStartRef.current = windowStartRef.current;
                setPending(entry);
                revealTo(entry.messageIndex);
                return;
            }
            pendingRef.current = null;
            pendingSessionRef.current = undefined;
            pendingWindowStartRef.current = null;
            setPending(null);
            scrollToTarget(node, jumpBehavior());
            startJump(token, "smooth");
        },
        [revealTo, scrollRef, sessionId, startJump, unpin],
    );

    // The window now covers the target: land on it, or cancel when it is gone.
    useLayoutEffect(() => {
        const el = scrollRef.current;
        if (!el || !enabled || !pending) return;
        if (pendingSessionRef.current !== sessionId) return;
        if (windowStart > pending.messageIndex) return;
        const node = findTarget(el, pending.id);
        pendingRef.current = null;
        pendingSessionRef.current = undefined;
        pendingWindowStartRef.current = null;
        setPending(null);
        if (!node) return;
        const token = tokenRef.current;
        scrollToTarget(node, "instant");
        const jump = startJump(token, "correction");
        startCorrection(jump, pending.id);
    }, [enabled, pending, scrollRef, sessionId, startCorrection, startJump, windowStart]);

    // A session switch or a disabled hook drops everything: the pending jump,
    // its timers, its observers and the reported positions.
    // biome-ignore lint/correctness/useExhaustiveDependencies: the session and the enabled flag are the trigger — they are not read inside the effect.
    useEffect(() => {
        cancelUpdate();
        endJump(false);
        pendingRef.current = null;
        pendingSessionRef.current = undefined;
        pendingWindowStartRef.current = null;
        setPending(null);
        setActiveId(undefined);
        setHighlightedId(undefined);
    }, [cancelUpdate, endJump, enabled, sessionId]);

    // The scroll position decides the current item. One frame per burst of
    // scroll events keeps the guide in step without a layout read per event.
    // The session is part of the lifecycle: a switch brings another
    // conversation's rows, and the current item has to be read from them.
    // biome-ignore lint/correctness/useExhaustiveDependencies: the session is the trigger — it is not read inside the effect.
    useEffect(() => {
        const el = scrollRef.current;
        if (!el || !enabled) return;
        const onScroll = (): void => {
            const jump = jumpRef.current;
            if (jump) {
                // A jump is animating: the guide keeps its target.
                jump.keepAlive();
                return;
            }
            scheduleUpdate();
        };
        el.addEventListener("scroll", onScroll, { passive: true });
        scheduleUpdate();
        return () => {
            el.removeEventListener("scroll", onScroll);
        };
    }, [enabled, scheduleUpdate, scrollRef, sessionId]);

    // The user always wins: any of these ends the jump, its correction and
    // the hold on the current item.
    useEffect(() => {
        const el = scrollRef.current;
        if (!el || !enabled) return;
        const onUserInput = (): void => {
            endJump(true);
        };
        const onKeyDown = (event: KeyboardEvent): void => {
            if (!SCROLL_KEYS.has(event.key)) return;
            onUserInput();
        };
        const onPointerDown = (event: PointerEvent): void => {
            // Only a press on the container itself is the scrollbar. A click
            // on a message is not a scroll intent and must not end the
            // correction.
            if (event.target !== el) return;
            onUserInput();
        };
        el.addEventListener("wheel", onUserInput, { passive: true });
        el.addEventListener("touchstart", onUserInput, { passive: true });
        el.addEventListener("touchmove", onUserInput, { passive: true });
        el.addEventListener("keydown", onKeyDown);
        el.addEventListener("pointerdown", onPointerDown, { passive: true });
        return () => {
            el.removeEventListener("wheel", onUserInput);
            el.removeEventListener("touchstart", onUserInput);
            el.removeEventListener("touchmove", onUserInput);
            el.removeEventListener("keydown", onKeyDown);
            el.removeEventListener("pointerdown", onPointerDown);
        };
    }, [enabled, endJump, scrollRef]);

    useEffect(
        () => () => {
            cancelUpdate();
            endJump(false);
        },
        [cancelUpdate, endJump],
    );

    return { activeId, highlightedId, navigate };
}
