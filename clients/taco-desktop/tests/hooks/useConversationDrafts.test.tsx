import { strict as assert } from "node:assert";
import { act, cleanup, renderHook } from "@testing-library/react";
import { StrictMode, Suspense } from "react";
import { afterEach, describe, it, vi } from "vitest";
import { useConversationDrafts } from "../../src/hooks/useConversationDrafts";
import type { StagedAttachment } from "../../src/lib/attachments";
import type { ConversationTarget } from "../../src/lib/chat/conversationDrafts";

const a: ConversationTarget = { kind: "session", workspace: "/a", sessionId: "same" };
const b: ConversationTarget = { kind: "session", workspace: "/b", sessionId: "same" };
const file: StagedAttachment = {
    id: "file",
    name: "image.png",
    mimeType: "image/png",
    kind: "image",
    size: 1,
    previewUrl: "blob:test",
};
afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

describe("useConversationDrafts", () => {
    it("keeps callbacks stable for semantically equal targets and initial models", () => {
        const model = { provider: "test", id: "model" };
        const { result, rerender } = renderHook(
            ({ target, initialModel }) => useConversationDrafts(target, initialModel),
            { initialProps: { target: a, initialModel: model }, wrapper: StrictMode },
        );
        const first = result.current;
        act(() => first.setInput("keep"));
        rerender({ target: { ...a }, initialModel: { ...model } });
        assert.equal(result.current.input, "keep");
        assert.equal(result.current.setInput, first.setInput);
        assert.equal(result.current.setAttachments, first.setAttachments);
        assert.equal(result.current.setSelectedModel, first.setSelectedModel);
        assert.equal(result.current.beginSubmission, first.beginSubmission);
        assert.equal(result.current.recoverSubmission, first.recoverSubmission);
    });

    it("does not let an abandoned render pin a new target's initial model", () => {
        const never = new Promise<never>(() => {});
        let suspended = 0;
        const initialModel = { provider: "test", id: "initial" };
        const { result, rerender } = renderHook(
            ({ target, model, suspend }) => {
                const drafts = useConversationDrafts(target, model);
                if (suspend) {
                    suspended++;
                    throw never;
                }
                return drafts;
            },
            {
                initialProps: { target: a, model: initialModel, suspend: false },
                wrapper: ({ children }) => (
                    <StrictMode>
                        <Suspense fallback={null}>{children}</Suspense>
                    </StrictMode>
                ),
            },
        );
        rerender({ target: b, model: { provider: "test", id: "abandoned" }, suspend: true });
        assert.ok(suspended > 0);
        rerender({ target: a, model: initialModel, suspend: false });
        const committedModel = { provider: "test", id: "committed" };
        rerender({ target: b, model: committedModel, suspend: false });
        assert.deepEqual(result.current.selectedModel, committedModel);
        assert.deepEqual(result.current.beginSubmission()?.selectedModel, committedModel);
    });

    it("retains A/B text and files and binds stale functional setters to their origin", () => {
        const { result, rerender } = renderHook(({ target }) => useConversationDrafts(target), {
            initialProps: { target: a },
        });
        const first = result.current;
        act(() => {
            first.setInput("A");
            first.setAttachments([file]);
        });
        rerender({ target: b });
        act(() => result.current.setInput("B"));
        act(() => first.setInput((prev) => `${prev}!`));
        assert.equal(result.current.input, "B");
        assert.deepEqual(result.current.attachments, []);
        rerender({ target: a });
        assert.equal(result.current.input, "A!");
        assert.deepEqual(result.current.attachments, [file]);
    });

    it("snapshots synchronous setter writes before React renders", () => {
        const { result } = renderHook(() => useConversationDrafts(a));
        act(() => {
            result.current.setInput("first");
            result.current.setInput((prev) => `${prev} second`);
            assert.equal(result.current.beginSubmission()?.input, "first second");
        });
        assert.equal(result.current.input, "first second");
    });

    it("completes an old send without clearing B or newer A edits", () => {
        const { result, rerender } = renderHook(({ target }) => useConversationDrafts(target), {
            initialProps: { target: a },
        });
        act(() => result.current.setInput("sent"));
        const submission = result.current.beginSubmission();
        assert.ok(submission);
        act(() => result.current.setInput("new A"));
        rerender({ target: b });
        act(() => {
            result.current.setInput("B");
            result.current.completeSubmission(submission, true);
        });
        assert.equal(result.current.input, "B");
        rerender({ target: a });
        assert.equal(result.current.input, "new A");
    });

    it("routes a picker completion through draft-to-session migration", async () => {
        const draft: ConversationTarget = { kind: "draft", workspace: "/a", draftId: "draft" };
        const { result, rerender } = renderHook(({ target }) => useConversationDrafts(target), {
            initialProps: { target: draft as ConversationTarget },
        });
        const savedSetter = result.current.setAttachments;
        let finish: ((files: StagedAttachment[]) => void) | undefined;
        const picker = new Promise<StagedAttachment[]>((resolve) => {
            finish = resolve;
        });
        const staging = picker.then((files) => savedSetter((prev) => [...prev, ...files]));
        act(() => result.current.migrateDraft("/a", "draft", "same"));
        rerender({ target: b });
        await act(async () => {
            finish?.([file]);
            await staging;
        });
        assert.deepEqual(result.current.attachments, []);
        rerender({ target: a });
        assert.deepEqual(result.current.attachments, [file]);
    });

    it("rerenders the origin's recovery action after a failed send resolves on B", () => {
        const { result, rerender } = renderHook(({ target }) => useConversationDrafts(target), {
            initialProps: { target: a },
        });
        act(() => {
            result.current.setInput("failed A");
            result.current.setAttachments([file]);
        });
        const submission = result.current.beginSubmission();
        assert.ok(submission);
        act(() => {
            result.current.setInput("");
            result.current.setAttachments([]);
            result.current.setInput("new A");
        });
        rerender({ target: b });
        act(() => {
            result.current.setInput("B");
            result.current.completeSubmission(submission, false);
        });
        assert.equal(result.current.input, "B");
        assert.deepEqual(result.current.recoveries, []);
        rerender({ target: a });
        assert.equal(result.current.input, "new A");
        assert.equal(result.current.recoveries.length, 1);
        act(() => result.current.recoverSubmission(submission.id));
        assert.equal(result.current.input, "failed A\nnew A");
        assert.deepEqual(result.current.attachments, [file]);
        assert.deepEqual(result.current.recoveries, []);
    });

    it("keeps URL ownership across switches and StrictMode replay, releasing on unmount", async () => {
        const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
        const { result, rerender, unmount } = renderHook(
            ({ target }) => useConversationDrafts(target),
            {
                initialProps: { target: a },
                wrapper: StrictMode,
            },
        );
        act(() => result.current.setAttachments([file]));
        rerender({ target: b });
        await act(async () => {
            await Promise.resolve();
        });
        assert.equal(revoke.mock.calls.length, 0);
        rerender({ target: a });
        assert.deepEqual(result.current.attachments, [file]);
        unmount();
        await act(async () => {
            await Promise.resolve();
        });
        assert.deepEqual(revoke.mock.calls, [["blob:test"]]);
    });

    it("retains an unknown completion only on its origin across navigation", () => {
        const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
        const { result, rerender } = renderHook(({ target }) => useConversationDrafts(target), {
            initialProps: { target: a },
        });
        act(() => {
            result.current.setInput("possibly sent A");
            result.current.setAttachments([file]);
        });
        const submission = result.current.beginSubmission();
        assert.ok(submission);
        act(() => {
            result.current.setInput("");
            result.current.setAttachments([]);
        });
        rerender({ target: b });
        act(() => {
            result.current.setInput("B");
            result.current.completeSubmission(submission, "unknown");
        });
        assert.equal(result.current.input, "B");
        assert.deepEqual(result.current.attachments, []);
        assert.equal(result.current.recoveries.length, 0);
        assert.deepEqual(revoke.mock.calls, []);
        rerender({ target: a });
        assert.equal(result.current.input, "");
        assert.deepEqual(result.current.attachments, []);
        assert.equal(result.current.recoveries.length, 1);
        assert.equal(result.current.recoveries[0]?.uncertain, true);
        assert.deepEqual(result.current.recoveries[0]?.target, a);
        act(() => result.current.recoverSubmission(submission.id));
        assert.equal(result.current.input, "possibly sent A");
        assert.deepEqual(result.current.attachments, [file]);
        assert.deepEqual(result.current.recoveries, []);
        assert.deepEqual(revoke.mock.calls, []);
        act(() => result.current.release(a));
        assert.deepEqual(revoke.mock.calls, [["blob:test"]]);
    });

    it("handles an absent target without creating a shared null draft", () => {
        const { result, rerender } = renderHook(({ target }) => useConversationDrafts(target), {
            initialProps: { target: null as ConversationTarget | null },
        });
        act(() => {
            result.current.setInput("ignored");
            result.current.setAttachments([file]);
        });
        assert.equal(result.current.input, "");
        assert.equal(result.current.beginSubmission(), null);
        rerender({ target: a });
        assert.equal(result.current.input, "");
        assert.deepEqual(result.current.attachments, []);
    });
});
