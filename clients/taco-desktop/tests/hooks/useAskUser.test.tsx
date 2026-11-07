import { strict as assert } from "node:assert";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { it, vi } from "vitest";
import { AskUserProvider, useAskUser } from "../../src/hooks/useAskUser";

it("captures the rendered target for both legacy tool-view calls", () => {
    const dispatch = vi.fn();
    const setAnswers = vi.fn();
    let target = { cwd: "/a", sid: "a" };
    const { result, rerender } = renderHook(() => useAskUser(), {
        wrapper: ({ children }: { children: ReactNode }) => (
            <AskUserProvider
                cwd={target.cwd}
                sid={target.sid}
                dispatchAskUser={dispatch}
                setAskUserAnswers={setAnswers}
            >
                {children}
            </AskUserProvider>
        ),
    });
    const original = result.current;
    target = { cwd: "/b", sid: "b" };
    rerender();
    act(() => {
        original.setAskUserAnswers("same", { answers: { q: "yes" }, questions: [] });
        original.answerAskUser("same", { q: "yes" });
    });
    assert.deepEqual(dispatch.mock.calls[0], [
        {
            type: "ASKUSER_ANSWERED",
            cwd: "/a",
            sid: "a",
            toolCallId: "same",
            answers: { q: "yes" },
        },
    ]);
    assert.deepEqual(setAnswers.mock.calls[0]?.[2], { workspace: "/a", sessionId: "a" });
});
