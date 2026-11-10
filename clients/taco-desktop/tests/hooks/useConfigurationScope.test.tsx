import { strict as assert } from "node:assert";
import type { ImConversationEntry } from "@taco-ai/protocol";
import { act, renderHook } from "@testing-library/react";
import { describe, it } from "vitest";
import { useConfigurationScope } from "../../src/hooks/useConfigurationScope";

const conversation: ImConversationEntry = {
    channelId: "wecom",
    peerId: "Product",
    chatId: "chat-1",
    sessionId: "session-1" as ImConversationEntry["sessionId"],
    lastUsedAt: 1,
};
const workspaces = { "/repo-a": {}, "/repo-b": {} };

describe("useConfigurationScope", () => {
    it("selects workspace and IM targets independently without changing activeCwd", () => {
        const { result } = renderHook(() =>
            useConfigurationScope({
                variant: "catalog",
                activeCwd: "/repo-a",
                workspaces,
                conversations: [conversation],
            }),
        );
        assert.equal(result.current.scope, "global");
        assert.equal(result.current.targetCwd, "/repo-a");
        act(() => result.current.setScope("workspace"));
        act(() => result.current.setTargetCwd("/repo-b"));
        assert.equal(result.current.targetCwd, "/repo-b");
        act(() => result.current.setScope("channel"));
        assert.equal(result.current.targetCwd, "im://wecom/Product/chat-1");
        act(() => result.current.setScope("effective"));
        assert.equal(result.current.targetCwd, "/repo-b");
    });

    it("uses the workspace-only variant for runtime tools", () => {
        const { result } = renderHook(() =>
            useConfigurationScope({
                variant: "runtime",
                activeCwd: "im://wecom/Product/chat-1",
                workspaces,
                conversations: [conversation],
            }),
        );
        assert.equal(result.current.scope, "workspace");
        assert.equal(result.current.targetCwd, "/repo-a");
    });
});
