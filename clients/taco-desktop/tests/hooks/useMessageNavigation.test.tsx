/**
 * useMessageNavigation — a guide jump owns the scroll position: it releases
 * the bottom follow, reveals rows the render window has not mounted, lands on
 * the target and keeps it there while the revealed rows finish rendering.
 * The user's own scroll always wins.
 */
import { strict as assert } from "node:assert";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useLayoutEffect, useRef } from "react";
import { afterEach, beforeEach, describe, it, vi } from "vitest";

import { type MessageNavigation, useMessageNavigation } from "../../src/hooks/useMessageNavigation";
import type { UserMessageGuideEntry } from "../../src/lib/chat/userMessageGuide";

/** Row height of the faked layout. */
const ROW_HEIGHT = 20;
/** Height of the faked viewport — its center sits at 50. */
const VIEWPORT_HEIGHT = 100;

/** happy-dom does no layout, so the rows get a geometry of their own. */
function setRect(el: HTMLElement, top: number, height: number): void {
    el.getBoundingClientRect = (() => ({
        top,
        bottom: top + height,
        height,
        left: 0,
        right: 100,
        width: 100,
        x: 0,
        y: top,
        toJSON: () => ({}),
    })) as typeof el.getBoundingClientRect;
}

/** happy-dom's ResizeObserver never fires, so the correction needs a handle. */
class FakeResizeObserver {
    static instances: FakeResizeObserver[] = [];
    callback: ResizeObserverCallback;
    observed: Element[] = [];

    constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
        FakeResizeObserver.instances.push(this);
    }

    observe(target: Element): void {
        this.observed.push(target);
    }

    unobserve(target: Element): void {
        this.observed = this.observed.filter((node) => node !== target);
    }

    disconnect(): void {
        this.observed = [];
    }

    /** Pretend an observed box changed size. */
    trigger(): void {
        this.callback([], this as unknown as ResizeObserver);
    }
}

function entry(id: string, messageIndex: number): UserMessageGuideEntry {
    return { id, messageIndex, text: id, images: [] };
}

interface HarnessProps {
    sessionId: string;
    windowStart: number;
    enabled: boolean;
    ids: string[];
    tops?: number[];
    revealTo: (index: number) => void;
    unpin: () => void;
    onResult: (result: MessageNavigation) => void;
}

function Harness({
    sessionId,
    windowStart,
    enabled,
    ids,
    tops,
    revealTo,
    unpin,
    onResult,
}: HarnessProps) {
    const ref = useRef<HTMLDivElement | null>(null);
    // The faked layout is applied before the hook's own layout effect runs,
    // so the hook reads the same geometry a browser would show it.
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        setRect(el, 0, VIEWPORT_HEIGHT);
        let index = windowStart;
        for (const node of el.querySelectorAll<HTMLElement>("[data-message-id]")) {
            setRect(node, tops?.[index] ?? index * ROW_HEIGHT, ROW_HEIGHT);
            index++;
        }
    });
    const result = useMessageNavigation({
        scrollRef: ref,
        sessionId,
        windowStart,
        enabled,
        revealTo,
        unpin,
    });
    onResult(result);
    return (
        <div ref={ref} data-testid="scroller">
            {ids.slice(windowStart).map((id) => (
                <div key={id} data-message-id={id}>
                    {id}
                </div>
            ))}
        </div>
    );
}

interface MountOptions {
    sessionId?: string;
    windowStart?: number;
    enabled?: boolean;
    ids?: string[];
    tops?: number[];
}

/** Mounts the harness and hands back the hook's latest result. */
function mount(options: MountOptions = {}) {
    const state = {
        sessionId: options.sessionId ?? "s1",
        windowStart: options.windowStart ?? 0,
        enabled: options.enabled ?? true,
        ids: options.ids ?? ["a", "b", "c"],
        tops: options.tops,
    };
    const revealTo = vi.fn();
    const unpin = vi.fn();
    let latest: MessageNavigation | undefined;
    const props = (): HarnessProps => ({
        ...state,
        revealTo,
        unpin,
        onResult: (result) => {
            latest = result;
        },
    });
    const view = render(<Harness {...props()} />);
    const result = (): MessageNavigation => {
        assert.ok(latest);
        return latest;
    };
    const rerender = (next: MountOptions): void => {
        state.sessionId = next.sessionId ?? state.sessionId;
        state.windowStart = next.windowStart ?? state.windowStart;
        state.enabled = next.enabled ?? state.enabled;
        state.ids = next.ids ?? state.ids;
        state.tops = next.tops ?? state.tops;
        view.rerender(<Harness {...props()} />);
    };
    const scroller = (): HTMLElement => {
        const el = view.container.querySelector<HTMLElement>("[data-testid=scroller]");
        assert.ok(el);
        return el;
    };
    return { result, rerender, revealTo, scroller, unpin };
}

/** Waits for one animation frame — the hook reads the layout in one. */
async function nextFrame(): Promise<void> {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
}

/** Lets the mutation observers deliver their records. */
async function flushMutations(): Promise<void> {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
}

/** The row carrying this message id. */
function row(container: HTMLElement, id: string): HTMLElement {
    const node = container.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
    assert.ok(node);
    return node;
}

/** Moves a row and changes its text: the target's own box really changed. */
function moveAndEdit(node: HTMLElement, top: number): void {
    setRect(node, top, ROW_HEIGHT);
    const text = node.firstChild;
    if (text) text.textContent = `${text.textContent}!`;
}

let scrollIntoView: ReturnType<typeof vi.fn>;

beforeEach(() => {
    scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    FakeResizeObserver.instances = [];
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("useMessageNavigation", () => {
    it("reveals a message the window has not mounted", () => {
        const { result, revealTo, unpin } = mount({ windowStart: 2 });
        act(() => result().navigate(entry("a", 0)));
        assert.deepEqual(revealTo.mock.calls[0], [0]);
        assert.equal(unpin.mock.calls.length, 1);
    });

    it("scrolls to the revealed target once the window covers it", () => {
        const { result, rerender } = mount({ windowStart: 2 });
        act(() => result().navigate(entry("a", 0)));
        rerender({ windowStart: 0 });
        assert.deepEqual(scrollIntoView.mock.calls[0], [{ block: "center", behavior: "instant" }]);
        assert.equal(result().activeId, "a");
        assert.equal(result().highlightedId, "a");
    });

    it("scrolls a mounted target smoothly and never reveals", () => {
        const { result, revealTo } = mount({ windowStart: 0 });
        act(() => result().navigate(entry("b", 1)));
        assert.equal(revealTo.mock.calls.length, 0);
        assert.deepEqual(scrollIntoView.mock.calls[0], [{ block: "center", behavior: "smooth" }]);
        assert.equal(result().activeId, "b");
        assert.equal(result().highlightedId, "b");
    });

    it("jumps instantly when the user prefers reduced motion", () => {
        vi.stubGlobal(
            "matchMedia",
            vi.fn(() => ({ matches: true })),
        );
        const { result } = mount({ windowStart: 0 });
        act(() => result().navigate(entry("b", 1)));
        assert.deepEqual(scrollIntoView.mock.calls[0], [{ block: "center", behavior: "instant" }]);
    });

    it("reads the reduced-motion preference at jump time", () => {
        let reduce = false;
        vi.stubGlobal(
            "matchMedia",
            vi.fn(() => ({ matches: reduce })),
        );
        const { result } = mount({ windowStart: 0 });
        // The preference changes while the app runs.
        reduce = true;
        act(() => result().navigate(entry("b", 1)));
        assert.deepEqual(scrollIntoView.mock.calls[0], [{ block: "center", behavior: "instant" }]);
    });

    it("keeps a revealed target centered while its content grows", async () => {
        vi.useFakeTimers();
        try {
            const { result, rerender, scroller } = mount({ windowStart: 2 });
            act(() => result().navigate(entry("a", 0)));
            rerender({ windowStart: 0 });
            assert.equal(scrollIntoView.mock.calls.length, 1);
            // The browser reports the landing scroll.
            scroller().dispatchEvent(new Event("scroll"));
            // The revealed rows finish rendering late: the correction outlives
            // the jump's own settle window.
            await act(async () => {
                vi.advanceTimersByTime(250);
            });
            const target = row(scroller(), "a");
            // The rows above grew: the target moved down.
            moveAndEdit(target, 400);
            await flushMutations();
            assert.equal(scrollIntoView.mock.calls.length, 2);
            // A box that moved without a mutation is corrected too.
            setRect(target, 500, ROW_HEIGHT);
            FakeResizeObserver.instances.at(-1)?.trigger();
            assert.equal(scrollIntoView.mock.calls.length, 3);
        } finally {
            vi.useRealTimers();
        }
    });

    it("lets the user's own input end the correction", async () => {
        const inputs: Array<(el: HTMLElement) => void> = [
            (el) => el.dispatchEvent(new WheelEvent("wheel", { deltaY: 120 })),
            (el) => el.dispatchEvent(new Event("touchstart")),
            (el) => el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" })),
            (el) => el.dispatchEvent(new Event("pointerdown")),
        ];
        for (const fire of inputs) {
            scrollIntoView.mockClear();
            const { result, rerender, scroller } = mount({ windowStart: 2 });
            act(() => result().navigate(entry("a", 0)));
            rerender({ windowStart: 0 });
            assert.equal(scrollIntoView.mock.calls.length, 1);
            fire(scroller());
            scroller().appendChild(document.createElement("p"));
            await act(async () => {
                await Promise.resolve();
            });
            assert.equal(scrollIntoView.mock.calls.length, 1);
            cleanup();
        }
    });

    it("keeps the target while the jump animates", async () => {
        const { result, scroller } = mount({ windowStart: 0 });
        act(() => result().navigate(entry("b", 1)));
        // The browser animates the jump and reports it as scroll events.
        scroller().dispatchEvent(new Event("scroll"));
        await act(async () => {
            await nextFrame();
        });
        assert.equal(result().activeId, "b");
    });

    it("keeps the target while a long jump is still reporting its scroll", async () => {
        vi.useFakeTimers();
        try {
            const { result, scroller } = mount({ windowStart: 0 });
            act(() => result().navigate(entry("b", 1)));
            // A jump across a long conversation animates for more than a
            // second and keeps reporting its progress. The target stays the
            // current item for as long as the animation runs.
            for (let tick = 0; tick < 30; tick++) {
                await act(async () => {
                    vi.advanceTimersByTime(50);
                });
                scroller().dispatchEvent(new Event("scroll"));
                assert.equal(result().activeId, "b");
            }
            // The animation stops: the scroll position decides again.
            await act(async () => {
                vi.advanceTimersByTime(300);
            });
            assert.equal(result().activeId, "c");
        } finally {
            vi.useRealTimers();
        }
    });

    it("follows the scroll position again after a jump has settled", async () => {
        vi.useFakeTimers();
        try {
            // Every row sits below the middle, so the viewport shows the
            // first one until the user scrolls further down.
            const { result, rerender, scroller } = mount({
                windowStart: 0,
                tops: [0, 200, 400],
            });
            act(() => result().navigate(entry("b", 1)));
            // The browser animates the jump and reports it.
            scroller().dispatchEvent(new Event("scroll"));
            // The animation ends on its own.
            await act(async () => {
                vi.advanceTimersByTime(300);
            });
            assert.equal(result().activeId, "a");

            // The user scrolls: the current item follows the viewport.
            rerender({ tops: [0, 200, 10] });
            scroller().dispatchEvent(new Event("scroll"));
            await act(async () => {
                vi.advanceTimersByTime(50);
            });
            assert.equal(result().activeId, "c");
        } finally {
            vi.useRealTimers();
        }
    });

    it("does not revive a jump that has already ended", async () => {
        vi.useFakeTimers();
        try {
            const { result, scroller } = mount({ windowStart: 0 });
            act(() => result().navigate(entry("b", 1)));
            scroller().dispatchEvent(new Event("scroll"));
            await act(async () => {
                vi.advanceTimersByTime(300);
            });
            // The jump is over: a scroll must not arm its timers again. The
            // only timer a scroll may leave behind is the frame that updates
            // the current item.
            const before = vi.getTimerCount();
            scroller().dispatchEvent(new Event("scroll"));
            await act(async () => {
                vi.advanceTimersByTime(50);
            });
            assert.equal(vi.getTimerCount(), before);
        } finally {
            vi.useRealTimers();
        }
    });

    it("ignores a streaming change that does not move the target", async () => {
        const { result, rerender, scroller } = mount({ windowStart: 2 });
        act(() => result().navigate(entry("a", 0)));
        rerender({ windowStart: 0 });
        assert.equal(scrollIntoView.mock.calls.length, 1);
        // Let the pending renders settle before watching the queries.
        await act(async () => {
            await nextFrame();
        });

        const container = scroller();
        const query = vi.spyOn(container, "querySelectorAll");
        // Another row streams: the target does not move, so nothing repositions.
        const other = row(container, "c");
        if (other.firstChild) other.firstChild.textContent = "c is streaming";
        await flushMutations();
        assert.equal(scrollIntoView.mock.calls.length, 1);
        assert.equal(query.mock.calls.length, 0);
        query.mockRestore();
    });

    it("lets a downward key end the correction", async () => {
        const { result, rerender, scroller } = mount({ windowStart: 2 });
        act(() => result().navigate(entry("a", 0)));
        rerender({ windowStart: 0 });
        assert.equal(scrollIntoView.mock.calls.length, 1);

        const container = scroller();
        const target = row(container, "a");
        scroller().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
        // The target moves after the user scrolled: the correction must not
        // pull the viewport back.
        moveAndEdit(target, 400);
        await flushMutations();
        assert.equal(scrollIntoView.mock.calls.length, 1);
    });

    it("reads a press on the container as a scrollbar, not a click on a message", async () => {
        const { result, rerender, scroller } = mount({ windowStart: 2 });
        act(() => result().navigate(entry("a", 0)));
        rerender({ windowStart: 0 });
        assert.equal(scrollIntoView.mock.calls.length, 1);

        const container = scroller();
        const target = row(container, "a");
        // The target's own box changed: the correction is still alive.
        moveAndEdit(target, 400);
        await flushMutations();
        assert.equal(scrollIntoView.mock.calls.length, 2);

        // A click on the message content is not a scrollbar grab.
        target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        moveAndEdit(target, 600);
        await flushMutations();
        assert.equal(scrollIntoView.mock.calls.length, 3);

        // A press on the container itself is the scrollbar.
        container.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        moveAndEdit(target, 800);
        await flushMutations();
        assert.equal(scrollIntoView.mock.calls.length, 3);
    });

    it("hands the current item back to the scroll position once the jump settles", async () => {
        vi.useFakeTimers();
        try {
            const { result, scroller } = mount({ windowStart: 0 });
            act(() => result().navigate(entry("b", 1)));
            scroller().dispatchEvent(new Event("scroll"));
            await act(async () => {
                vi.advanceTimersByTime(50);
            });
            assert.equal(result().activeId, "b");
            // The animation ends: the scroll position decides again.
            await act(async () => {
                vi.advanceTimersByTime(300);
            });
            assert.equal(result().activeId, "c");
        } finally {
            vi.useRealTimers();
        }
    });

    it("drops the pending jump when the session changes", () => {
        const { result, rerender } = mount({ sessionId: "s1", windowStart: 2 });
        act(() => result().navigate(entry("a", 0)));
        rerender({ sessionId: "s2", windowStart: 0 });
        assert.equal(result().activeId, undefined);
        assert.equal(result().highlightedId, undefined);
        assert.equal(scrollIntoView.mock.calls.length, 0);
    });

    it("drops the pending jump when the hook is disabled", () => {
        const { result, rerender } = mount({ windowStart: 2 });
        act(() => result().navigate(entry("a", 0)));
        rerender({ enabled: false });
        assert.equal(result().activeId, undefined);
        assert.equal(result().highlightedId, undefined);
        assert.equal(scrollIntoView.mock.calls.length, 0);
    });

    it("cancels a jump whose target disappeared before the reveal", () => {
        const { result, rerender } = mount({ windowStart: 2, ids: ["a", "b", "c"] });
        act(() => result().navigate(entry("b", 1)));
        rerender({ windowStart: 0, ids: ["a", "c"] });
        assert.equal(scrollIntoView.mock.calls.length, 0);
    });

    it("lets a newer jump take over from an older one", () => {
        const { result, rerender } = mount({ windowStart: 2 });
        act(() => result().navigate(entry("a", 0)));
        act(() => result().navigate(entry("c", 2)));
        rerender({ windowStart: 0 });
        assert.equal(scrollIntoView.mock.calls.length, 1);
        assert.deepEqual(scrollIntoView.mock.calls[0], [{ block: "center", behavior: "smooth" }]);
        assert.equal(result().activeId, "c");
    });

    it("tracks the current item as the last row above the viewport center", async () => {
        const { result, rerender, scroller } = mount({
            windowStart: 0,
            ids: ["a", "b", "c"],
            tops: [200, 400, 600],
        });
        await waitFor(() => assert.equal(result().activeId, "a"));
        rerender({ windowStart: 0, ids: ["a", "b", "c"], tops: [0, 20, 40] });
        scroller().dispatchEvent(new Event("scroll"));
        await waitFor(() => assert.equal(result().activeId, "c"));
    });

    it("falls back to the nearest row below the center when none is above", async () => {
        const { result, scroller } = mount({
            windowStart: 0,
            ids: ["a", "b", "c"],
            tops: [200, 400, 600],
        });
        scroller().dispatchEvent(new Event("scroll"));
        await waitFor(() => assert.equal(result().activeId, "a"));
    });

    it("recomputes the active item after a session switch", async () => {
        const { result, rerender } = mount({
            sessionId: "s1",
            ids: ["a", "b", "c"],
            tops: [0, 200, 400],
        });
        await waitFor(() => assert.equal(result().activeId, "a"));

        // Another session opens: its own rows replace the old ones.
        rerender({ sessionId: "s2", ids: ["x"], tops: [0] });
        await waitFor(() => assert.equal(result().activeId, "x"));
    });

    it("cancels a reveal whose window moved but stops short of the target", async () => {
        const { result, rerender, scroller } = mount({
            windowStart: 4,
            ids: ["a", "b", "c", "d", "e", "f"],
        });
        act(() => result().navigate(entry("a", 0)));
        assert.equal(result().activeId, "a");

        // The conversation was replaced: the window moved, yet still starts
        // after the target, so the reveal can never land.
        rerender({ windowStart: 2, ids: ["x", "y", "z"], tops: [0, 0, 0] });
        assert.equal(scrollIntoView.mock.calls.length, 0);

        // The current item follows the scroll position again.
        scroller().dispatchEvent(new Event("scroll"));
        await waitFor(() => assert.equal(result().activeId, "z"));
    });

    it("re-reads the current item when its row is replaced without a scroll", async () => {
        const { result, rerender } = mount({ ids: ["live-a", "b"], tops: [0, 200] });
        await waitFor(() => assert.equal(result().activeId, "live-a"));

        // A snapshot restore swaps the live id for the history id.
        rerender({ ids: ["hist-a", "b"], tops: [0, 200] });
        await waitFor(() => assert.equal(result().activeId, "hist-a"));
    });

    it("cancels a pending target that disappeared, so the current item updates again", async () => {
        const { result, rerender, scroller } = mount({ windowStart: 2, ids: ["a", "b", "c"] });
        // The target is above the mounted window: the jump waits for a reveal.
        act(() => result().navigate(entry("a", 0)));
        assert.equal(result().activeId, "a");

        // The message is gone from the session and the window does not move.
        rerender({ ids: ["x", "b", "c"] });
        // A scroll arrives: the current item must be calculated again instead
        // of the stale pending freezing it.
        scroller().dispatchEvent(new Event("scroll"));
        await act(async () => {
            await nextFrame();
        });
        assert.equal(result().activeId, "c");
    });
});
