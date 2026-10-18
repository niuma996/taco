import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { ImConversationEntry } from "@taco-ai/protocol";
import {
    chatPolicyKey,
    DEFAULT_IM_WORKSPACE_POLICY,
    describeImChatOverrides,
    describeImPolicyRules,
    describeImPolicySources,
    mergeImWorkspacePolicyPatch,
    normalizePolicyDocument,
    resolveChannelDefaultFromDocument,
    resolveImWorkspacePolicyFromDocument,
    validateImWorkspacePolicy,
} from "../../src/channels/imWorkspacePolicy.ts";

const ROUTE = { channelId: "wechat", peerId: "u1", chatId: "c1" };

describe("imWorkspacePolicy", () => {
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
                    executionDir: { mode: "per-chat" as const },
                },
            },
        };
        const resolved = resolveImWorkspacePolicyFromDocument(doc, ROUTE);
        assert.equal(resolved.tools.shell, "allow");
        assert.equal(resolved.tools.fsTools, "allow");
        assert.deepEqual(resolved.executionDir, { mode: "per-chat" });
        // A different chat on the same channel only sees the channel default.
        const other = resolveImWorkspacePolicyFromDocument(doc, { ...ROUTE, chatId: "c2" });
        assert.equal(other.tools.shell, "allow");
        assert.equal(other.tools.fsTools, "deny");
        assert.deepEqual(other.executionDir, { mode: "shared" });
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

    it("validate requires an absolute path for a custom execution directory", () => {
        assert.throws(
            () =>
                validateImWorkspacePolicy(
                    { executionDir: { mode: "custom", path: "rel/path" } },
                    "t",
                ),
            /absolute/,
        );
        assert.throws(
            () => validateImWorkspacePolicy({ executionDir: { mode: "nope" } }, "t"),
            /executionDir/,
        );
        assert.deepEqual(
            validateImWorkspacePolicy({ executionDir: { mode: "custom", path: "/tmp/ws" } }, "t")
                .executionDir,
            { mode: "custom", path: "/tmp/ws" },
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

    it("appends chat command rules to channel rules instead of replacing them", () => {
        const doc = {
            default: {
                commands: { allow: ["ls"], deny: ["rm -rf *"] },
            },
            chats: {
                [chatPolicyKey(ROUTE)]: {
                    commands: { allow: ["git status"], deny: ["git push *"] },
                },
            },
        };
        const resolved = resolveImWorkspacePolicyFromDocument(doc, ROUTE);
        assert.deepEqual(resolved.commands.allow, ["ls", "git status"]);
        assert.deepEqual(resolved.commands.deny, ["rm -rf *", "git push *"]);
    });

    it("deduplicates appended rules across layers", () => {
        const doc = {
            default: { commands: { allow: ["ls"] } },
            chats: { [chatPolicyKey(ROUTE)]: { commands: { allow: ["ls", "pwd"] } } },
        };
        assert.deepEqual(resolveImWorkspacePolicyFromDocument(doc, ROUTE).commands.allow, [
            "ls",
            "pwd",
        ]);
    });

    it("clears a field at the stored layer when the patch value is null", () => {
        const merged = mergeImWorkspacePolicyPatch(
            {
                tools: { shell: "allow" },
                commands: { mode: "auto", allow: ["ls"] },
                perChatScratch: true,
            },
            {
                tools: { shell: null },
                perChatScratch: null,
            },
        );
        assert.deepEqual(merged, { commands: { mode: "auto", allow: ["ls"] } });
    });

    it("clears a whole binding with null", () => {
        const merged = mergeImWorkspacePolicyPatch(
            { binding: { executionCwd: "/tmp/ws" } },
            { binding: null },
        );
        assert.deepEqual(merged, {});
    });

    it("describes the winning layer for each single-value field", () => {
        const doc = {
            default: { tools: { shell: "allow" } },
            chats: {
                [chatPolicyKey(ROUTE)]: {
                    perChatScratch: true,
                    executionDir: { mode: "custom", path: "/tmp/chat" },
                },
            },
        };

        const channelSources = describeImPolicySources(doc, null);
        assert.deepEqual(channelSources.shell, { value: "allow", source: "channel" });
        assert.deepEqual(channelSources.fsTools, { value: "deny", source: "default" });
        assert.deepEqual(channelSources.commandMode, { value: "ask", source: "default" });
        assert.deepEqual(channelSources.executionDir, {
            value: { mode: "shared" },
            source: "default",
        });

        const chatSources = describeImPolicySources(doc, ROUTE);
        assert.deepEqual(chatSources.shell, { value: "allow", source: "channel" });
        assert.deepEqual(chatSources.executionDir, {
            value: { mode: "custom", path: "/tmp/chat" },
            source: "chat",
        });
    });

    it("derives the working directory from legacy binding and perChatScratch fields", () => {
        const legacyBinding = resolveImWorkspacePolicyFromDocument(
            { default: { binding: { executionCwd: "/tmp/project" } } },
            ROUTE,
        );
        assert.deepEqual(legacyBinding.executionDir, {
            mode: "custom",
            path: "/tmp/project",
        });

        const legacyScratch = resolveImWorkspacePolicyFromDocument(
            { default: { perChatScratch: true } },
            ROUTE,
        );
        assert.deepEqual(legacyScratch.executionDir, { mode: "per-chat" });
    });

    // The old runtime let a channel-level binding win over a chat's
    // perChatScratch flag. Keeping that means existing policy files behave
    // exactly as before after the migration.
    it("keeps a legacy perChatScratch inert when the channel pinned a directory", () => {
        const doc = {
            default: { binding: { executionCwd: "/tmp/project" } },
            chats: { [chatPolicyKey(ROUTE)]: { perChatScratch: true } },
        };
        const resolved = resolveImWorkspacePolicyFromDocument(doc, ROUTE);
        assert.deepEqual(resolved.executionDir, { mode: "custom", path: "/tmp/project" });
    });

    it("lets a chat override a channel directory with the canonical field", () => {
        const doc = {
            default: { executionDir: { mode: "custom" as const, path: "/tmp/project" } },
            chats: { [chatPolicyKey(ROUTE)]: { executionDir: { mode: "per-chat" as const } } },
        };
        const resolved = resolveImWorkspacePolicyFromDocument(doc, ROUTE);
        assert.deepEqual(resolved.executionDir, { mode: "per-chat" });
    });

    it("reports which layer owns the working directory", () => {
        const doc = {
            default: { executionDir: { mode: "shared" as const } },
            chats: { [chatPolicyKey(ROUTE)]: { executionDir: { mode: "per-chat" as const } } },
        };
        assert.deepEqual(describeImPolicySources(doc, null).executionDir, {
            value: { mode: "shared" },
            source: "channel",
        });
        assert.deepEqual(describeImPolicySources(doc, ROUTE).executionDir, {
            value: { mode: "per-chat" },
            source: "chat",
        });
    });

    it("normalizes legacy fields into the canonical execution directory", () => {
        const normalized = normalizePolicyDocument({
            default: { binding: { executionCwd: "/tmp/project" } },
            chats: { [chatPolicyKey(ROUTE)]: { perChatScratch: true } },
        });
        assert.deepEqual(normalized.default, {
            executionDir: { mode: "custom", path: "/tmp/project" },
        });
        // The chat's legacy flag was inert under the channel binding, so it
        // disappears instead of silently becoming an explicit choice.
        assert.deepEqual(normalized.chats?.[chatPolicyKey(ROUTE)], {});
    });

    it("normalizes a legacy perChatScratch into an explicit per-chat directory", () => {
        const normalized = normalizePolicyDocument({
            default: { perChatScratch: true },
        });
        assert.deepEqual(normalized.default, { executionDir: { mode: "per-chat" } });
    });

    it("groups rules by contributing layer and marks only the edited layer editable", () => {
        const doc = {
            default: { commands: { allow: ["ls"], deny: [] } },
            chats: {
                [chatPolicyKey(ROUTE)]: { commands: { allow: ["git status"] } },
            },
        };
        const globalRules = { allow: ["pnpm test"], deny: ["bash *"] };

        const channelRules = describeImPolicyRules(doc, null, globalRules);
        assert.deepEqual(channelRules.allow, [
            { source: "global", rules: ["pnpm test"], editable: false },
            { source: "channel", rules: ["ls"], editable: true },
        ]);
        assert.deepEqual(channelRules.deny, [
            { source: "global", rules: ["bash *"], editable: false },
            { source: "channel", rules: [], editable: true },
        ]);

        const chatRules = describeImPolicyRules(doc, ROUTE, globalRules);
        assert.deepEqual(chatRules.allow, [
            { source: "global", rules: ["pnpm test"], editable: false },
            { source: "channel", rules: ["ls"], editable: false },
            { source: "chat", rules: ["git status"], editable: true },
        ]);
    });
});

it("IM command blacklists permit wrappers without permitting wrapper allow rules", () => {
    const policy = validateImWorkspacePolicy(
        { commands: { mode: "auto", deny: ["bash *", "powershell *"] } },
        "t",
    );
    assert.deepEqual(policy.commands.deny, ["bash *", "powershell *"]);
    assert.throws(
        () => validateImWorkspacePolicy({ commands: { allow: ["bash *"] } }, "t"),
        /wrapper/,
    );
});
