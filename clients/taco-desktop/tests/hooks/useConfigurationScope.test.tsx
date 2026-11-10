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
    name: "Product support",
    lastUsedAt: 1,
};
const workspaces = { "/repo-a": {}, "/repo-b": {} };
const imCwd = "im://wecom/Product/chat-1";

describe("useConfigurationScope", () => {
    it("defaults to the chat target's effective catalog and retains it across source tabs", () => {
        const { result } = renderHook(() =>
            useConfigurationScope({
                activeCwd: "/repo-a",
                active: true,
                mode: "workspace",
                workspaces,
                conversations: [conversation],
            }),
        );
        assert.equal(result.current.scope, "effective");
        assert.equal(result.current.targetCwd, "/repo-a");
        act(() => result.current.setTargetCwd("/repo-b"));
        act(() => result.current.setScope("global"));
        assert.equal(result.current.targetCwd, "/repo-b");
        act(() => result.current.setScope("builtin"));
        assert.equal(result.current.targetCwd, "/repo-b");
        assert.ok(result.current.targetOptions.every((option) => option.kind === "workspace"));
    });

    it("keeps the current IM target available before conversation metadata arrives", () => {
        const { result, rerender } = renderHook(
            ({ conversations }: { conversations: ImConversationEntry[] | null }) =>
                useConfigurationScope({
                    activeCwd: imCwd,
                    active: true,
                    mode: "im",
                    workspaces,
                    conversations,
                }),
            { initialProps: { conversations: null as ImConversationEntry[] | null } },
        );
        assert.equal(result.current.targetCwd, imCwd);
        assert.ok(result.current.targetOptions.some((option) => option.value === imCwd));
        rerender({ conversations: [conversation] });
        assert.equal(result.current.targetCwd, imCwd);
    });

    it("resets to the main chat and effective source on reentry or chat target change", () => {
        const { result, rerender } = renderHook(
            ({ active, activeCwd }) =>
                useConfigurationScope({
                    activeCwd,
                    active,
                    mode: activeCwd.startsWith("im://") ? "im" : "workspace",
                    workspaces,
                    conversations: [conversation],
                }),
            { initialProps: { active: true, activeCwd: "/repo-a" } },
        );
        act(() => result.current.setTargetCwd("/repo-b"));
        act(() => result.current.setScope("workspace"));
        assert.equal(result.current.targetCwd, "/repo-b");
        rerender({ active: false, activeCwd: "/repo-a" });
        rerender({ active: true, activeCwd: "/repo-a" });
        assert.equal(result.current.targetCwd, "/repo-a");
        assert.equal(result.current.scope, "effective");
        rerender({ active: true, activeCwd: imCwd });
        assert.equal(result.current.targetCwd, imCwd);
        assert.equal(result.current.scope, "effective");
    });
    it("follows the top category in a configuration pane and remembers a target per category", () => {
        const { result, rerender } = renderHook(
            ({ mode }: { mode: "workspace" | "im" }) =>
                useConfigurationScope({
                    mode,
                    active: true,
                    activeCwd: "/repo-a",
                    workspaces,
                    conversations: [conversation],
                }),
            { initialProps: { mode: "workspace" as "workspace" | "im" } },
        );
        act(() => result.current.setTargetCwd("/repo-b"));
        act(() => result.current.setScope("global"));
        rerender({ mode: "im" });
        assert.equal(result.current.targetCwd, imCwd);
        assert.equal(result.current.scope, "effective");
        assert.equal(result.current.targetOptions.length, 1);
        assert.equal(result.current.targetOptions[0].label, "Product support");
        rerender({ mode: "workspace" });
        assert.equal(result.current.targetCwd, "/repo-b");
        assert.ok(result.current.targetOptions.every((option) => option.kind === "workspace"));
    });

    it("leaves the opposite category empty instead of loading the active chat's workspace", () => {
        const { result } = renderHook(() =>
            useConfigurationScope({
                mode: "im",
                active: true,
                activeCwd: "/repo-a",
                workspaces,
                conversations: [],
            }),
        );
        assert.equal(result.current.targetCwd, undefined);
        assert.equal(result.current.hasTarget, false);
    });
    it("pins the first asynchronously loaded target across subsequent list reordering", () => {
        const { result, rerender } = renderHook(
            ({ conversations }: { conversations: ImConversationEntry[] | null }) =>
                useConfigurationScope({
                    mode: "im",
                    active: true,
                    activeCwd: "/repo-a",
                    workspaces,
                    conversations,
                }),
            { initialProps: { conversations: null as ImConversationEntry[] | null } },
        );
        assert.equal(result.current.targetCwd, undefined);
        rerender({ conversations: [conversation] });
        assert.equal(result.current.targetCwd, imCwd);
        rerender({
            conversations: [{ ...conversation, peerId: "Other", chatId: "chat-2" }, conversation],
        });
        assert.equal(result.current.targetCwd, imCwd);
    });
    it("retains the category target on reentry when the main chat belongs to the other category", () => {
        const other = { ...conversation, chatId: "chat-2", sessionId: "session-2" };
        const { result, rerender } = renderHook(
            ({ active }) =>
                useConfigurationScope({
                    mode: "im",
                    active,
                    activeCwd: "/repo-a",
                    workspaces,
                    conversations: [conversation, other],
                }),
            { initialProps: { active: true } },
        );
        act(() => result.current.setTargetCwd("im://wecom/Product/chat-2"));
        rerender({ active: false });
        rerender({ active: true });
        assert.equal(result.current.targetCwd, "im://wecom/Product/chat-2");
    });
});
