/**
 * useStableUserMessageGuide — the guide's entries keep their identity while
 * the session's user messages do not change, so a streaming assistant token
 * does not re-render the rail.
 */
import { strict as assert } from "node:assert";
import { cleanup, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UserMessageGuide } from "../../src/components/UserMessageGuide";
import { useMessageNavigation } from "../../src/hooks/useMessageNavigation";
import { useMessageWindow } from "../../src/hooks/useMessageWindow";
import { useStableUserMessageGuide } from "../../src/hooks/useStableUserMessageGuide";
import * as useI18n from "../../src/i18n/useI18n";
import type { UiMessage } from "../../src/lib/chat/chatUtils";

/** The rail calls `useT` once per render, so its calls count the renders. */
const useTMock = vi.fn(() => ({
    t: (key: string, opts?: Record<string, unknown>) =>
        opts ? `${key} ${Object.values(opts).join(" ")}` : key,
}));
vi.spyOn(useI18n, "useT").mockImplementation(useTMock as unknown as typeof useI18n.useT);

afterEach(() => {
    cleanup();
    useTMock.mockClear();
});

function userMessage(id: string, text: string): UiMessage {
    return { id, kind: "user", text, ts: 0 };
}

function assistantMessage(id: string, text: string): UiMessage {
    return { id, kind: "assistant", text, ts: 1, tools: [], thinking: [] };
}

describe("useStableUserMessageGuide", () => {
    it("keeps the entries while an assistant token streams", () => {
        let messages: UiMessage[] = [userMessage("u1", "hello"), assistantMessage("a1", "hi")];
        const { result, rerender } = renderHook(() => useStableUserMessageGuide(messages));
        const first = result.current;

        messages = [...messages, assistantMessage("a1", "hi there")];
        rerender();
        assert.equal(result.current, first);
    });

    it("derives new entries when a user message changes", () => {
        let messages: UiMessage[] = [userMessage("u1", "hello")];
        const { result, rerender } = renderHook(() => useStableUserMessageGuide(messages));
        const first = result.current;

        messages = [userMessage("u1", "hello again")];
        rerender();
        assert.notEqual(result.current, first);
        assert.equal(result.current[0]?.text, "hello again");
    });

    it("derives new entries when the message indexes shift", () => {
        let messages: UiMessage[] = [userMessage("u1", "hello")];
        const { result, rerender } = renderHook(() => useStableUserMessageGuide(messages));
        const first = result.current;

        // A row above the user message shifts its absolute index.
        messages = [assistantMessage("a0", "earlier"), userMessage("u1", "hello")];
        rerender();
        assert.notEqual(result.current, first);
        assert.equal(result.current[0]?.messageIndex, 1);
    });

    it("derives new entries when an image changes", () => {
        const image = { type: "image", data: "QUJD", mimeType: "image/png" } as const;
        let messages: UiMessage[] = [{ id: "u1", kind: "user", text: "", ts: 0, images: [image] }];
        const { result, rerender } = renderHook(() => useStableUserMessageGuide(messages));
        const first = result.current;

        messages = [
            {
                id: "u1",
                kind: "user",
                text: "",
                ts: 0,
                images: [{ ...image, data: "REVG" }],
            },
        ];
        rerender();
        assert.notEqual(result.current, first);
    });
});

describe("UserMessageGuide — 渲染次数", () => {
    it("流式输出不重渲染导轨", async () => {
        const user = userEvent.setup();
        const onNavigate = vi.fn();
        function StreamHarness() {
            const [messages, setMessages] = useState<UiMessage[]>([
                userMessage("u1", "hello"),
                assistantMessage("a1", "hi"),
            ]);
            const entries = useStableUserMessageGuide(messages);
            return (
                <>
                    <UserMessageGuide entries={entries} activeId="u1" onNavigate={onNavigate} />
                    <button
                        type="button"
                        onClick={() =>
                            setMessages((prev) => {
                                const last = prev.at(-1);
                                if (last?.kind !== "assistant") return prev;
                                return [...prev.slice(0, -1), { ...last, text: `${last.text}!` }];
                            })
                        }
                    >
                        stream
                    </button>
                </>
            );
        }

        render(<StreamHarness />);
        const before = useTMock.mock.calls.length;
        assert.ok(before > 0);

        await user.click(screen.getByRole("button", { name: "stream" }));
        expect(useTMock.mock.calls.length).toBe(before);
    });

    it("整条链路下流式输出不重渲染导轨", async () => {
        const user = userEvent.setup();
        // The chat's own wiring: the message window, the navigation and the
        // guide. Every prop of the rail has to stay stable across a token.
        const unpin = () => {};
        function ChatHarness() {
            const ref = useRef<HTMLDivElement | null>(null);
            const [messages, setMessages] = useState<UiMessage[]>([
                userMessage("u1", "hello"),
                assistantMessage("a1", "hi"),
            ]);
            const { start, revealTo } = useMessageWindow(messages, "s1", ref);
            const { activeId, navigate } = useMessageNavigation({
                scrollRef: ref,
                sessionId: "s1",
                windowStart: start,
                enabled: true,
                revealTo,
                unpin,
            });
            const entries = useStableUserMessageGuide(messages);
            return (
                <>
                    <div ref={ref} />
                    <UserMessageGuide entries={entries} activeId={activeId} onNavigate={navigate} />
                    <button
                        type="button"
                        onClick={() =>
                            setMessages((prev) => {
                                const last = prev.at(-1);
                                if (last?.kind !== "assistant") return prev;
                                return [...prev.slice(0, -1), { ...last, text: `${last.text}!` }];
                            })
                        }
                    >
                        stream
                    </button>
                </>
            );
        }

        render(<ChatHarness />);
        const before = useTMock.mock.calls.length;
        assert.ok(before > 0);

        await user.click(screen.getByRole("button", { name: "stream" }));
        expect(useTMock.mock.calls.length).toBe(before);
    });
});
