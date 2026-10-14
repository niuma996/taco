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
});
