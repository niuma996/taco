import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { ImConversationEntry } from "@taco-ai/protocol";
import {
    chatPolicyKey,
    DEFAULT_IM_WORKSPACE_POLICY,
    describeImChatOverrides,
    resolveChannelDefaultFromDocument,
    resolveImWorkspacePolicyFromDocument,
    validateImWorkspacePolicy,
} from "../../src/channels/imWorkspacePolicy.ts";

const ROUTE = { channelId: "wechat", peerId: "u1", chatId: "c1" };

describe("imWorkspacePolicy", () => {
    it("defaults deny everything and asks for commands", () => {
        assert.deepEqual(DEFAULT_IM_WORKSPACE_POLICY, {
            tools: { fsTools: "deny", shell: "deny" },
            commands: { mode: "ask" },
        });
    });

    it("resolves to defaults for an empty or absent document", () => {
        assert.deepEqual(
            resolveImWorkspacePolicyFromDocument(undefined, ROUTE),
            DEFAULT_IM_WORKSPACE_POLICY,
        );
        assert.deepEqual(
            resolveImWorkspacePolicyFromDocument({}, ROUTE),
            DEFAULT_IM_WORKSPACE_POLICY,
        );
    });

    it("layers chat override over channel default over defaults", () => {
        const doc = {
            default: { tools: { shell: "allow" as const, fsTools: "deny" as const } },
            chats: {
                [chatPolicyKey(ROUTE)]: {
                    tools: { fsTools: "allow" as const, shell: "allow" as const },
                    perChatScratch: true,
                },
            },
        };
        const resolved = resolveImWorkspacePolicyFromDocument(doc, ROUTE);
        assert.equal(resolved.tools.shell, "allow");
        assert.equal(resolved.tools.fsTools, "allow");
        assert.equal(resolved.perChatScratch, true);
        // A different chat on the same channel only sees the channel default.
        const other = resolveImWorkspacePolicyFromDocument(doc, { ...ROUTE, chatId: "c2" });
        assert.equal(other.tools.shell, "allow");
        assert.equal(other.tools.fsTools, "deny");
        assert.equal(other.perChatScratch, undefined);
    });

    it("fails closed to defaults when the document is corrupt", () => {
        assert.deepEqual(
            resolveImWorkspacePolicyFromDocument({ default: { tools: { shell: "maybe" } } }, ROUTE),
            DEFAULT_IM_WORKSPACE_POLICY,
        );
        assert.deepEqual(
            resolveImWorkspacePolicyFromDocument("not-an-object", ROUTE),
            DEFAULT_IM_WORKSPACE_POLICY,
        );
    });

    // Regression: a corrupt chat override must NOT erase a valid channel default.
    // Per-layer granularity: each validatePartial is wrapped in its own try.
    it("corrupt chat override preserves the valid channel default for that chat", () => {
        const doc = {
            default: { tools: { shell: "allow" as const } },
            chats: {
                [chatPolicyKey(ROUTE)]: { tools: { shell: "maybe" as const } },
            },
        };
        const resolved = resolveImWorkspacePolicyFromDocument(doc, ROUTE);
        assert.equal(resolved.tools.shell, "allow", "channel default must survive bad override");
    });

    it("corrupt channel default is bypassed; chat override still applies", () => {
        const doc = {
            default: { tools: { shell: "maybe" as const } },
            chats: {
                [chatPolicyKey(ROUTE)]: {
                    tools: { fsTools: "allow" as const, shell: "deny" as const },
                },
            },
        };
        const resolved = resolveImWorkspacePolicyFromDocument(doc, ROUTE);
        assert.equal(resolved.tools.shell, "deny");
        assert.equal(resolved.tools.fsTools, "allow");
    });

    it("validate rejects bad tool verdicts and bad command modes", () => {
        assert.throws(() => validateImWorkspacePolicy({ tools: { shell: "maybe" } }, "t"), /shell/);
        assert.throws(() => validateImWorkspacePolicy({ tools: { fsTools: 1 } }, "t"), /fsTools/);
        assert.throws(() => validateImWorkspacePolicy({ commands: { mode: "yolo" } }, "t"), /mode/);
    });

    it("validate requires an absolute binding path", () => {
        assert.throws(
            () => validateImWorkspacePolicy({ binding: { executionCwd: "rel/path" } }, "t"),
            /absolute/,
        );
        assert.equal(
            validateImWorkspacePolicy({ binding: { executionCwd: "/tmp/ws" } }, "t").binding
                ?.executionCwd,
            "/tmp/ws",
        );
    });

    it("validate rejects a command rule list containing non-strings", () => {
        assert.throws(
            () => validateImWorkspacePolicy({ commands: { mode: "auto", allow: ["ls", 7] } }, "t"),
            /allow/,
        );
    });

    it("validate rejects shell wrappers as allow rules", () => {
        assert.throws(
            () =>
                validateImWorkspacePolicy({ commands: { mode: "auto", allow: ["bash -c"] } }, "t"),
            /wrapper/,
        );
    });

    it("chatPolicyKey is a stable full-length sha256 over the route key", () => {
        const a = chatPolicyKey(ROUTE);
        assert.equal(a, chatPolicyKey({ ...ROUTE }));
        assert.match(a, /^[0-9a-f]{64}$/);
        assert.notEqual(a, chatPolicyKey({ ...ROUTE, chatId: "c2" }));
    });

    it("resolveChannelDefaultFromDocument skips the chat layer", () => {
        const doc = {
            default: { tools: { shell: "allow" as const } },
            chats: {
                // Any chat override must NOT bleed into the channel-level resolve.
                [chatPolicyKey(ROUTE)]: { tools: { fsTools: "allow" as const } },
            },
        };
        const resolved = resolveChannelDefaultFromDocument(doc);
        assert.equal(resolved.tools.shell, "allow");
        assert.equal(resolved.tools.fsTools, "deny", "chat override must not leak upward");
    });

    it("resolveChannelDefaultFromDocument fails closed on corrupt input", () => {
        assert.deepEqual(resolveChannelDefaultFromDocument(undefined), DEFAULT_IM_WORKSPACE_POLICY);
        assert.deepEqual(resolveChannelDefaultFromDocument("nope"), DEFAULT_IM_WORKSPACE_POLICY);
        assert.deepEqual(
            resolveChannelDefaultFromDocument({ default: { tools: { shell: "maybe" } } }),
            DEFAULT_IM_WORKSPACE_POLICY,
        );
    });

    it("describeImChatOverrides annotates live conversations and keeps orphans", () => {
        const liveRoute = ROUTE;
        const orphanKey = chatPolicyKey({ channelId: "wechat", peerId: "ghost", chatId: "g1" });
        const conversations: ImConversationEntry[] = [
            {
                channelId: "wechat",
                peerId: liveRoute.peerId,
                chatId: liveRoute.chatId,
                sessionId: "s1",
                lastUsedAt: 1,
            },
            // A different channel — must not match.
            {
                channelId: "feishu",
                peerId: liveRoute.peerId,
                chatId: liveRoute.chatId,
                sessionId: "s2",
                lastUsedAt: 1,
            },
        ];
        const doc = {
            chats: {
                [chatPolicyKey(liveRoute)]: { tools: { fsTools: "allow" as const } },
                [orphanKey]: { perChatScratch: true },
            },
        };
        const entries = describeImChatOverrides(doc, "wechat", conversations);
        assert.equal(entries.length, 2);
        const live = entries.find((e) => e.route);
        const orphan = entries.find((e) => !e.route);
        assert.ok(live);
        assert.deepEqual(live?.route, liveRoute);
        assert.deepEqual(live?.patch, { tools: { fsTools: "allow" } });
        assert.ok(orphan);
        assert.equal(orphan?.key, orphanKey);
        assert.deepEqual(orphan?.patch, { perChatScratch: true });
    });

    it("describeImChatOverrides returns [] for missing chats map", () => {
        assert.deepEqual(describeImChatOverrides({}, "wechat", []), []);
        assert.deepEqual(describeImChatOverrides(undefined, "wechat", []), []);
    });
});
