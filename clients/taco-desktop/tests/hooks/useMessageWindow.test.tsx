/**
 * useMessageWindow — a long conversation mounts only its tail, cut at a turn
 * start, and resets when another session becomes active.
 */
import { strict as assert } from "node:assert";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, it } from "vitest";

import { useMessageWindow } from "../../src/hooks/useMessageWindow";
import type { UiMessage } from "../../src/lib/chat/chatUtils";

afterEach(cleanup);

/** `turns` turns of one user row followed by `perTurn` assistant rows. */
function conversation(turns: number, perTurn: number, prefix = "m"): UiMessage[] {
    const out: UiMessage[] = [];
    for (let t = 0; t < turns; t++) {
        out.push({ id: `${prefix}-u${t}`, kind: "user", text: "q", ts: t });
        for (let a = 0; a < perTurn; a++) {
            out.push({
                id: `${prefix}-a${t}-${a}`,
                kind: "assistant",
                text: "a",
                ts: t,
                tools: [],
                thinking: [],
            });
        }
    }
    return out;
}

const scrollRef = { current: null };

describe("useMessageWindow", () => {
    it("renders a short conversation whole", () => {
        const msgs = conversation(3, 2);
        const { result } = renderHook(() => useMessageWindow(msgs, "s1", scrollRef));
        assert.equal(result.current.start, 0);
    });

    it("starts a long conversation at a turn boundary near the tail", () => {
        const msgs = conversation(50, 2);
        const { result } = renderHook(() => useMessageWindow(msgs, "s1", scrollRef));
        const { start } = result.current;
        assert.ok(start > 0 && start < msgs.length);
        assert.equal(msgs[start]?.kind, "user");
    });

    it("expands toward older rows on showEarlier, still at a turn boundary", () => {
        const msgs = conversation(50, 2);
        const { result } = renderHook(() => useMessageWindow(msgs, "s1", scrollRef));
        const before = result.current.start;
        act(() => result.current.showEarlier());
        const after = result.current.start;
        assert.ok(after < before);
        assert.equal(msgs[after]?.kind, "user");
    });

    it("keeps the start fixed while new rows append", () => {
        let msgs = conversation(50, 2);
        const { result, rerender } = renderHook(() => useMessageWindow(msgs, "s1", scrollRef));
        const before = result.current.start;
        msgs = [...msgs, ...conversation(1, 3, "new")];
        rerender();
        assert.equal(result.current.start, before);
    });

    it("re-seeds when another session becomes active", () => {
        let msgs = conversation(50, 2, "a");
        let sid = "s1";
        const { result, rerender } = renderHook(() => useMessageWindow(msgs, sid, scrollRef));
        act(() => result.current.showEarlier());
        act(() => result.current.showEarlier());
        msgs = conversation(4, 1, "b");
        sid = "s2";
        rerender();
        assert.equal(result.current.start, 0);
    });

    it("seeds once rows arrive for a session that opened empty", () => {
        let msgs: UiMessage[] = [];
        const { result, rerender } = renderHook(() => useMessageWindow(msgs, "s1", scrollRef));
        assert.equal(result.current.start, 0);
        msgs = conversation(50, 2);
        rerender();
        assert.ok(result.current.start > 0);
    });

    it("reveals the turn containing an arbitrary older row", () => {
        const msgs = conversation(50, 2);
        const { result } = renderHook(() => useMessageWindow(msgs, "s1", scrollRef));
        act(() => result.current.revealTo(32));
        assert.equal(result.current.start, 30);
    });

    it("does not move the start when the target is already mounted", () => {
        const msgs = conversation(50, 2);
        const { result } = renderHook(() => useMessageWindow(msgs, "s1", scrollRef));
        const before = result.current.start;
        act(() => result.current.revealTo(before + 1));
        assert.equal(result.current.start, before);
    });

    it("releases a show-earlier anchor when a reveal takes over the scroll", async () => {
        const el = document.createElement("div");
        Object.defineProperty(el, "scrollHeight", {
            configurable: true,
            get: () => 1000,
        });
        el.scrollTop = 400;
        const ref = { current: el };
        const msgs = conversation(50, 2);
        const { result } = renderHook(() => useMessageWindow(msgs, "s1", ref));

        act(() => result.current.showEarlier());
        // The anchor keeps the distance from the bottom: rows that finish
        // rendering above the viewport are compensated.
        el.scrollTop = 0;
        el.appendChild(document.createElement("p"));
        await flushMutations();
        assert.equal(el.scrollTop, 400);

        // A reveal inside the expanded window leaves the start where it is, so
        // the anchor would keep fighting the navigation.
        const start = result.current.start;
        act(() => result.current.revealTo(start + 1));
        assert.equal(result.current.start, start);

        el.scrollTop = 0;
        el.appendChild(document.createElement("p"));
        await flushMutations();
        assert.equal(el.scrollTop, 0);
    });
});

/** Lets the mutation observers deliver their records. */
async function flushMutations(): Promise<void> {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
}
