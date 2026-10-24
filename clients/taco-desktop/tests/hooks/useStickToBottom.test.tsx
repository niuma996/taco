/**
 * useStickToBottom — auto-follow must survive the streaming race where a
 * scroll event is dispatched after content grew but before the catch-up
 * scroll ran, and must still yield when the user scrolls up.
 */
import { strict as assert } from "node:assert";
import { cleanup, render, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, it } from "vitest";

import { useStickToBottom } from "../../src/hooks/primitives/useStickToBottom";

afterEach(cleanup);

/** happy-dom does no layout, so geometry is faked on the node itself. */
function fakeGeometry(el: HTMLElement, clientHeight: number, scrollHeight: number) {
    const g = { top: 0, clientHeight, scrollHeight };
    Object.defineProperty(el, "clientHeight", { get: () => g.clientHeight });
    Object.defineProperty(el, "scrollHeight", { get: () => g.scrollHeight });
    Object.defineProperty(el, "scrollTop", {
        get: () => g.top,
        set: (v: number) => {
            g.top = Math.max(0, Math.min(v, g.scrollHeight - g.clientHeight));
        },
    });
    el.scrollTo = ((opts: ScrollToOptions) => {
        el.scrollTop = opts.top ?? 0;
    }) as typeof el.scrollTo;
    return g;
}

function Harness({ onEl }: { onEl: (el: HTMLDivElement) => void }) {
    const ref = useRef<HTMLDivElement | null>(null);
    useStickToBottom(ref);
    return (
        <div
            ref={(el) => {
                if (el && ref.current !== el) {
                    onEl(el);
                    ref.current = el;
                }
            }}
        />
    );
}

function mount() {
    let el: HTMLDivElement | undefined;
    let g: ReturnType<typeof fakeGeometry> | undefined;
    render(
        <Harness
            onEl={(node) => {
                el = node;
                g = fakeGeometry(node, 100, 300);
            }}
        />,
    );
    assert.ok(el && g);
    return { el, g };
}

/** Content grows: the DOM mutates and layout gets taller. */
function grow(el: HTMLElement, g: { scrollHeight: number }, px: number) {
    g.scrollHeight += px;
    el.appendChild(document.createElement("p"));
}

/** Mounts a container and hands back the hook's explicit stick operations. */
function mountPinned() {
    let pin: (() => void) | undefined;
    let unpin: (() => void) | undefined;
    let el: HTMLDivElement | undefined;
    let g: ReturnType<typeof fakeGeometry> | undefined;
    function PinHarness() {
        const ref = useRef<HTMLDivElement | null>(null);
        const ops = useStickToBottom(ref);
        pin = ops.pin;
        unpin = ops.unpin;
        return (
            <div
                ref={(node) => {
                    if (node && ref.current !== node) {
                        el = node;
                        g = fakeGeometry(node, 100, 300);
                        ref.current = node;
                    }
                }}
            />
        );
    }
    render(<PinHarness />);
    assert.ok(el && g && pin && unpin);
    return { el, g, pin, unpin };
}

describe("useStickToBottom", () => {
    it("snaps to the bottom on mount", () => {
        const { g } = mount();
        assert.equal(g.top, 200);
    });

    it("keeps following when a stale scroll event lands after content grew", async () => {
        const { el, g } = mount();
        // The catch-up scroll's own event is dispatched only now, after the
        // next chunk already made the content 200px taller. Distance-from-
        // bottom reads 200 here, which used to unpin for good.
        grow(el, g, 200);
        el.dispatchEvent(new Event("scroll"));
        await waitFor(() => assert.equal(g.top, 400));

        grow(el, g, 50);
        await waitFor(() => assert.equal(g.top, 450));
    });

    it("stops following once the user scrolls up, and resumes at the bottom", async () => {
        const { el, g } = mount();
        el.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
        g.top = 50;
        el.dispatchEvent(new Event("scroll"));
        grow(el, g, 100);
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        assert.equal(g.top, 50);

        g.top = g.scrollHeight - g.clientHeight;
        el.dispatchEvent(new Event("scroll"));
        grow(el, g, 40);
        await waitFor(() => assert.equal(g.top, 340));
    });

    it("keeps following when scrollTop moves up without user input", async () => {
        const { el, g } = mount();
        // Content collapsing above the viewport, or another hook restoring a
        // position, moves scrollTop up with no wheel / touch / key involved.
        g.top = 50;
        el.dispatchEvent(new Event("scroll"));
        grow(el, g, 100);
        await waitFor(() => assert.equal(g.top, 300));
    });

    it("unpins on an upward key, and pin() re-sticks", async () => {
        const { el, g, pin } = mountPinned();
        el.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp" }));
        grow(el, g, 100);
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        assert.equal(g.top, 200);

        pin();
        assert.equal(g.top, 300);
    });

    it("unpins explicitly, with no user input, and pin() re-sticks", async () => {
        const { el, g, pin, unpin } = mountPinned();
        unpin();
        grow(el, g, 100);
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        assert.equal(g.top, 200);

        pin();
        assert.equal(g.top, 300);
    });

    it("stays unpinned when the jump lands near the bottom", async () => {
        const { el, g, unpin } = mountPinned();
        // The user had scrolled up, so the jump moves the viewport back down.
        el.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
        g.top = 100;
        el.dispatchEvent(new Event("scroll"));
        unpin();
        // The jump sets scrollTop 40px above the bottom, and the browser
        // dispatches a scroll for it.
        g.top = g.scrollHeight - g.clientHeight - 40;
        el.dispatchEvent(new Event("scroll"));
        grow(el, g, 100);
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        assert.equal(g.top, 160);
    });

    it("pin() clears the explicit unpin, so a later scroll re-arms the follow", async () => {
        const { el, g, pin, unpin } = mountPinned();
        unpin();
        pin();
        // The user scrolls up: the follow stops.
        el.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
        g.top = 100;
        el.dispatchEvent(new Event("scroll"));
        // Scrolling back to the bottom re-arms it — the explicit unpin is over.
        g.top = g.scrollHeight - g.clientHeight;
        el.dispatchEvent(new Event("scroll"));
        grow(el, g, 40);
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        assert.equal(g.top, 240);
    });

    it("re-snaps when resetKey changes", () => {
        let el: HTMLDivElement | undefined;
        let g: ReturnType<typeof fakeGeometry> | undefined;
        function KeyedHarness({ k }: { k: string }) {
            const ref = useRef<HTMLDivElement | null>(null);
            useStickToBottom(ref, k);
            return (
                <div
                    ref={(node) => {
                        if (node && ref.current !== node) {
                            el = node;
                            g = fakeGeometry(node, 100, 300);
                            ref.current = node;
                        }
                    }}
                />
            );
        }
        const view = render(<KeyedHarness k="a" />);
        assert.ok(el && g);
        g.top = 0;
        g.scrollHeight = 500;
        view.rerender(<KeyedHarness k="b" />);
        assert.equal(g.top, 400);
    });
});
