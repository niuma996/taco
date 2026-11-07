import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { conversationKey } from "../../../src/lib/chat/conversationIdentity.ts";

describe("conversation identity", () => {
    it("separates the same session id in different workspaces", () => {
        assert.notEqual(
            conversationKey({ kind: "session", target: { workspace: "/a", sessionId: "same" } }),
            conversationKey({ kind: "session", target: { workspace: "/b", sessionId: "same" } }),
        );
    });

    it("separates drafts from existing sessions and from other drafts", () => {
        const draft = conversationKey({
            kind: "draft",
            target: { workspace: "/a", draftId: "same" },
        });
        assert.notEqual(
            draft,
            conversationKey({ kind: "session", target: { workspace: "/a", sessionId: "same" } }),
        );
        assert.notEqual(
            draft,
            conversationKey({ kind: "draft", target: { workspace: "/a", draftId: "next" } }),
        );
        assert.equal(
            draft,
            conversationKey({ kind: "draft", target: { workspace: "/a", draftId: "same" } }),
        );
    });
});
