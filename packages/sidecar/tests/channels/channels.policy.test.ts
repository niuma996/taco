import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ImConversationEntry } from "@taco-ai/protocol";
import { asWorkspaceId } from "@taco-ai/protocol";
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
import { ImWorkspacePolicyStore } from "../../src/channels/imWorkspacePolicyStore.ts";
import { ChannelRegistry } from "../../src/channels/registry.ts";
import { ProviderKeyStore } from "../../src/runtime/models/providerKeyStore.ts";
import type { WorkspaceRuntime } from "../../src/runtime/workspace.ts";
import { SidecarServer } from "../../src/server/server.ts";
import { WorkspaceRegistry } from "../../src/server/workspaceRegistry.ts";

describe("imWorkspacePolicy", () => {
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
                resolveImWorkspacePolicyFromDocument(
                    { default: { tools: { shell: "maybe" } } },
                    ROUTE,
                ),
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
            assert.equal(
                resolved.tools.shell,
                "allow",
                "channel default must survive bad override",
            );
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
            assert.throws(
                () => validateImWorkspacePolicy({ tools: { shell: "maybe" } }, "t"),
                /shell/,
            );
            assert.throws(
                () => validateImWorkspacePolicy({ tools: { fsTools: 1 } }, "t"),
                /fsTools/,
            );
            assert.throws(
                () => validateImWorkspacePolicy({ commands: { mode: "yolo" } }, "t"),
                /mode/,
            );
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
                validateImWorkspacePolicy(
                    { executionDir: { mode: "custom", path: "/tmp/ws" } },
                    "t",
                ).executionDir,
                { mode: "custom", path: "/tmp/ws" },
            );
        });

        it("validate rejects a command rule list containing non-strings", () => {
            assert.throws(
                () =>
                    validateImWorkspacePolicy(
                        { commands: { mode: "auto", allow: ["ls", 7] } },
                        "t",
                    ),
                /allow/,
            );
        });

        it("validate rejects shell wrappers as allow rules", () => {
            assert.throws(
                () =>
                    validateImWorkspacePolicy(
                        { commands: { mode: "auto", allow: ["bash -c"] } },
                        "t",
                    ),
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
            assert.deepEqual(
                resolveChannelDefaultFromDocument(undefined),
                DEFAULT_IM_WORKSPACE_POLICY,
            );
            assert.deepEqual(
                resolveChannelDefaultFromDocument("nope"),
                DEFAULT_IM_WORKSPACE_POLICY,
            );
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

            const fromDefault = <T>(value: T) => ({ value, source: "default" as const });
            const channelSources = describeImPolicySources(doc, null);
            assert.deepEqual(channelSources.shell, {
                value: "allow",
                source: "channel",
                // The channel scope's parent is the built-in default.
                inherited: fromDefault("deny"),
            });
            assert.deepEqual(channelSources.fsTools, {
                value: "deny",
                source: "default",
                inherited: fromDefault("deny"),
            });
            assert.deepEqual(channelSources.commandMode, {
                value: "ask",
                source: "default",
                inherited: fromDefault("ask"),
            });
            assert.deepEqual(channelSources.executionDir, {
                value: { mode: "shared" },
                source: "default",
                inherited: fromDefault({ mode: "shared" }),
            });

            const chatSources = describeImPolicySources(doc, ROUTE);
            assert.deepEqual(chatSources.shell, {
                value: "allow",
                source: "channel",
                // A chat's parent is the channel result.
                inherited: { value: "allow", source: "channel" },
            });
            assert.deepEqual(chatSources.executionDir, {
                value: { mode: "custom", path: "/tmp/chat" },
                source: "chat",
                inherited: fromDefault({ mode: "shared" }),
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
                inherited: { value: { mode: "shared" }, source: "default" },
            });
            assert.deepEqual(describeImPolicySources(doc, ROUTE).executionDir, {
                value: { mode: "per-chat" },
                source: "chat",
                inherited: { value: { mode: "shared" }, source: "channel" },
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
});

describe("imWorkspacePolicyStore", () => {
    const ROUTE = { channelId: "wechat", peerId: "u1", chatId: "c1" };
    const chatKey = chatPolicyKey(ROUTE);

    let home: string;
    let store: ImWorkspacePolicyStore;

    beforeEach(() => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), "taco-im-policy-"));
        store = new ImWorkspacePolicyStore(home);
    });

    afterEach(() => {
        fs.rmSync(home, { recursive: true, force: true });
    });

    function policyPath(channelId: string): string {
        return path.join(home, "im-workspace-policies", `${channelId}.json`);
    }

    describe("ImWorkspacePolicyStore", () => {
        it("resolves to defaults when no file exists", () => {
            assert.deepEqual(store.resolve(ROUTE), DEFAULT_IM_WORKSPACE_POLICY);
        });

        it("persists a channel default and resolves it for every chat", async () => {
            await store.setChannelDefault("wechat", {
                tools: { shell: "allow", fsTools: "deny" },
                commands: { mode: "auto", allow: ["ls", "git *"] },
            });

            const resolved = store.resolve(ROUTE);
            assert.equal(resolved.tools.shell, "allow");
            assert.equal(resolved.tools.fsTools, "deny");
            assert.equal(resolved.commands.mode, "auto");
            assert.deepEqual(resolved.commands.allow, ["ls", "git *"]);
            // A sibling chat sees the same channel default.
            assert.equal(store.resolve({ ...ROUTE, chatId: "c2" }).tools.shell, "allow");
        });

        it("chat override wins over the channel default, siblings unaffected", async () => {
            await store.setChannelDefault("wechat", { tools: { shell: "deny" } });
            await store.setChatOverride(ROUTE, {
                tools: { shell: "allow" },
                executionDir: { mode: "per-chat" },
            });

            assert.equal(store.resolve(ROUTE).tools.shell, "allow");
            assert.deepEqual(store.resolve(ROUTE).executionDir, { mode: "per-chat" });
            assert.equal(store.resolve({ ...ROUTE, chatId: "c2" }).tools.shell, "deny");
            assert.deepEqual(store.resolve({ ...ROUTE, chatId: "c2" }).executionDir, {
                mode: "shared",
            });
        });

        // Regression: the setters take a *patch*. Replacing the stored value
        // wholesale meant editing one field silently revoked unrelated grants
        // (e.g. setting the execution dir dropped an existing shell: allow).
        it("setChannelDefault merges, preserving fields the patch omits", async () => {
            await store.setChannelDefault("wechat", {
                tools: { shell: "allow" },
                commands: { mode: "auto", allow: ["ls"] },
            });
            await store.setChannelDefault("wechat", { executionDir: { mode: "per-chat" } });

            const resolved = store.resolve(ROUTE);
            assert.equal(resolved.tools.shell, "allow");
            assert.equal(resolved.commands.mode, "auto");
            assert.deepEqual(resolved.commands.allow, ["ls"]);
            assert.deepEqual(resolved.executionDir, { mode: "per-chat" });
        });

        it("setChatOverride merges, and an explicit tightening still wins", async () => {
            await store.setChatOverride(ROUTE, { tools: { shell: "allow" } });
            await store.setChatOverride(ROUTE, { executionDir: { mode: "per-chat" } });
            assert.equal(store.resolve(ROUTE).tools.shell, "allow");

            await store.setChatOverride(ROUTE, { tools: { shell: "deny" } });
            assert.equal(store.resolve(ROUTE).tools.shell, "deny");
            assert.deepEqual(store.resolve(ROUTE).executionDir, { mode: "per-chat" });
        });

        it("clearChatOverride is idempotent and falls back to channel default", async () => {
            await store.setChannelDefault("wechat", { tools: { shell: "allow" } });
            await store.setChatOverride(ROUTE, { tools: { shell: "deny" } });
            await store.clearChatOverride(ROUTE);
            await store.clearChatOverride(ROUTE); // idempotent

            assert.equal(store.resolve(ROUTE).tools.shell, "allow");
        });

        it("clears a single field with null and keeps the layer's other overrides", async () => {
            await store.setChannelDefault("wechat", {
                tools: { shell: "allow", fsTools: "allow" },
                commands: { mode: "auto" },
            });
            await store.setChatOverride(ROUTE, {
                tools: { shell: "deny" },
                executionDir: { mode: "per-chat" },
            });

            await store.setChatOverride(ROUTE, { tools: { shell: null } });

            const resolved = store.resolve(ROUTE);
            assert.equal(resolved.tools.shell, "allow", "cleared chat field falls back to channel");
            assert.equal(resolved.tools.fsTools, "allow");
            assert.deepEqual(
                resolved.executionDir,
                { mode: "per-chat" },
                "sibling overrides survive",
            );
            assert.equal(resolved.commands.mode, "auto");
            assert.deepEqual(store.readDocument("wechat").chats?.[chatKey], {
                executionDir: { mode: "per-chat" },
            });
        });

        it("migrates legacy working-directory fields on the next write", async () => {
            // A policy file written before the canonical `executionDir` field.
            fs.mkdirSync(path.dirname(policyPath("wechat")), { recursive: true });
            fs.writeFileSync(
                policyPath("wechat"),
                JSON.stringify({ default: { perChatScratch: true } }),
            );

            await store.setChannelDefault("wechat", { tools: { shell: "allow" } });

            const doc = store.readDocument("wechat");
            assert.deepEqual(doc.default?.executionDir, { mode: "per-chat" });
            assert.equal(doc.default?.perChatScratch, undefined);
            assert.equal(doc.default?.binding, undefined);
        });

        it("lets a chat override a channel directory with the canonical field", async () => {
            await store.setChannelDefault("wechat", {
                executionDir: { mode: "custom", path: "/tmp/project" },
            });
            await store.setChatOverride(ROUTE, { executionDir: { mode: "per-chat" } });

            assert.deepEqual(store.resolve(ROUTE).executionDir, { mode: "per-chat" });
            assert.deepEqual(store.resolve({ ...ROUTE, chatId: "c2" }).executionDir, {
                mode: "custom",
                path: "/tmp/project",
            });
        });

        // Hand-editing the JSON is currently the only way to configure a policy,
        // so resolve() must not cache the document — a cached read would ignore the
        // edit until the sidecar restarted. resolve() only runs on
        // ensureWorkspace's cache-miss path, so re-reading is free.
        it("picks up an external edit to the policy file without restarting", () => {
            assert.equal(store.resolve(ROUTE).tools.shell, "deny");

            fs.mkdirSync(path.dirname(policyPath("wechat")), { recursive: true });
            fs.writeFileSync(
                policyPath("wechat"),
                JSON.stringify({ default: { tools: { shell: "allow" } } }),
            );

            assert.equal(store.resolve(ROUTE).tools.shell, "allow");
        });

        it("survives reopening the store (disk persistence)", async () => {
            await store.setChatOverride(ROUTE, { tools: { shell: "allow" } });
            const reopened = new ImWorkspacePolicyStore(home);
            assert.equal(reopened.resolve(ROUTE).tools.shell, "allow");
        });

        it("writes the policy file with 0o600", async () => {
            // POSIX mode bits are a no-op on Windows (see fsPermissions.ts);
            // the per-user %LOCALAPPDATA% ACL is the only thing keeping the
            // policy file off sibling accounts on a shared host, and that's
            // out of scope for this assertion.
            if (process.platform === "win32") return;

            await store.setChannelDefault("wechat", { tools: { shell: "allow" } });
            const mode = fs.statSync(policyPath("wechat")).mode & 0o777;
            assert.equal(mode, 0o600);
        });

        it("resolves to defaults on a corrupt file rather than throwing", async () => {
            const dir = path.dirname(policyPath("wechat"));
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(policyPath("wechat"), "{ not json");
            assert.deepEqual(store.resolve(ROUTE), DEFAULT_IM_WORKSPACE_POLICY);
        });

        it("throws on an invalid channel default patch", async () => {
            await assert.rejects(
                store.setChannelDefault("wechat", { tools: { shell: "maybe" } } as never),
                /shell/,
            );
        });

        it("keeps invalid layers verbatim instead of dropping them on an unrelated write", async () => {
            const otherKey = chatPolicyKey({ ...ROUTE, chatId: "c2" });
            const badChat = { commands: { deny: ["rm *", 42] } };
            fs.mkdirSync(path.dirname(policyPath("wechat")), { recursive: true });
            fs.writeFileSync(
                policyPath("wechat"),
                JSON.stringify({
                    default: { perChatScratch: true },
                    chats: { [otherKey]: badChat },
                }),
            );

            await store.setChatOverride(ROUTE, { tools: { shell: "allow" } });

            const doc = store.readDocument("wechat");
            assert.deepEqual(doc.chats?.[otherKey], badChat);
            assert.deepEqual(doc.chats?.[chatKey], { tools: { shell: "allow" } });
            // Valid layers still migrate in the same write.
            assert.deepEqual(doc.default, { executionDir: { mode: "per-chat" } });
        });

        it("rejects a write whose merged target layer is invalid and leaves the file untouched", async () => {
            const bad = { tools: { shell: "allow" }, commands: { allow: ["git status", 1] } };
            fs.mkdirSync(path.dirname(policyPath("wechat")), { recursive: true });
            fs.writeFileSync(policyPath("wechat"), JSON.stringify({ default: bad }));

            await assert.rejects(
                store.setChannelDefault("wechat", { tools: { fsTools: "allow" } }),
                /allow/,
            );
            assert.deepEqual(store.readDocument("wechat"), { default: bad });
        });

        it("namespaces per channelId", async () => {
            await store.setChannelDefault("wechat", { tools: { shell: "allow" } });
            assert.equal(store.resolve({ ...ROUTE, channelId: "feishu" }).tools.shell, "deny");
        });

        it("tracks notified workspace keys separately and durably", async () => {
            assert.equal(store.hasNotified("im://wechat/u1/c1"), false);
            await store.markNotified("im://wechat/u1/c1");
            assert.equal(store.hasNotified("im://wechat/u1/c1"), true);
            const reopened = new ImWorkspacePolicyStore(home);
            assert.equal(reopened.hasNotified("im://wechat/u1/c1"), true);
            assert.equal(reopened.hasNotified("im://wechat/u2/c1"), false);
        });

        it("readDocument returns the stored document and {} when absent", async () => {
            assert.deepEqual(store.readDocument("wechat"), {});
            await store.setChannelDefault("wechat", { tools: { shell: "allow" } });
            await store.setChatOverride(ROUTE, { perChatScratch: true });

            const doc = store.readDocument("wechat");
            assert.deepEqual(doc.default, { tools: { shell: "allow" } });
            const chats = doc.chats ?? {};
            const keys = Object.keys(chats);
            assert.equal(keys.length, 1);
            const firstKey = keys[0];
            assert.ok(firstKey, "expected one chat key");
            // The write also migrates the legacy field to the canonical shape.
            assert.deepEqual(chats[firstKey], { executionDir: { mode: "per-chat" } });
        });

        it("clearChatOverrideByKey drops an orphan override without a route", async () => {
            await store.setChatOverride(ROUTE, { tools: { shell: "allow" } });
            const stored = store.readDocument("wechat");
            const orphanKey = Object.keys(stored.chats ?? {})[0];
            assert.ok(orphanKey, "expected one chat key");
            // Sanity: the live route resolves to the stored grant.
            assert.equal(store.resolve(ROUTE).tools.shell, "allow");

            await store.clearChatOverrideByKey("wechat", orphanKey);

            assert.deepEqual(store.readDocument("wechat").chats, {});
            assert.equal(store.resolve(ROUTE).tools.shell, "deny", "channel default kicks in");
        });
    });

    describe("legacy IM auto migration", () => {
        function writeRaw(doc: unknown): void {
            fs.mkdirSync(path.dirname(policyPath("wechat")), { recursive: true });
            fs.writeFileSync(policyPath("wechat"), JSON.stringify(doc));
        }

        it("turns a pre-0.2.11 auto whitelist into manual approval, keeping the allow list", () => {
            writeRaw({ default: { commands: { mode: "auto", allow: ["ls *"] } } });
            assert.deepEqual(store.resolve(ROUTE).commands, { mode: "ask", allow: ["ls *"] });
        });

        it("migrates plain auto layers too, since old auto only passed read-only commands", () => {
            writeRaw({
                default: { commands: { mode: "auto" } },
                chats: { [chatKey]: { commands: { allow: ["git *"] } } },
            });
            assert.equal(store.resolve(ROUTE).commands.mode, "ask");
            assert.equal(store.resolve({ ...ROUTE, chatId: "other" }).commands.mode, "ask");
        });

        it("migrates an explicit auto chat layer under a non-auto channel", () => {
            writeRaw({ chats: { [chatKey]: { commands: { mode: "auto" } } } });
            assert.equal(store.resolve(ROUTE).commands.mode, "ask");
        });

        it("leaves versioned files untouched", () => {
            writeRaw({ version: 2, default: { commands: { mode: "auto", allow: ["ls *"] } } });
            assert.equal(store.resolve(ROUTE).commands.mode, "auto");
        });

        it("writes the migration back on first read", async () => {
            writeRaw({ default: { commands: { mode: "auto", allow: ["ls *"] } } });
            store.resolve(ROUTE);
            // Flush the store's write chain with a no-op write on another channel.
            await store.clearChatOverrideByKey("other", "none");
            const doc = JSON.parse(fs.readFileSync(policyPath("wechat"), "utf8"));
            assert.equal(doc.version, 2);
            assert.equal(doc.default.commands.mode, "ask");
            assert.deepEqual(doc.default.commands.allow, ["ls *"]);
        });
    });
});

describe("policyInvalidation", () => {
    describe("policy invalidation", () => {
        function makeServerWithRegistry(): {
            server: SidecarServer;
            workspaces: WorkspaceRegistry;
        } {
            const workspaces = new WorkspaceRegistry(async () => {
                throw new Error("unexpected workspace build in test");
            });
            return {
                server: new SidecarServer({
                    providerKeyStore: new ProviderKeyStore({}),
                    workspaceRegistry: workspaces,
                }),
                workspaces,
            };
        }

        it("workspacesForChannel returns tracked keys and [] for unknown channels", () => {
            const reg = new ChannelRegistry();
            assert.deepEqual(reg.workspacesForChannel("wechat"), []);
            reg.trackWorkspace("wechat", "im://wechat/u1/c1");
            reg.trackWorkspace("wechat", "im://wechat/u2/c1");
            reg.trackWorkspace("feishu", "im://feishu/u1/c1");
            assert.deepEqual(reg.workspacesForChannel("wechat").sort(), [
                "im://wechat/u1/c1",
                "im://wechat/u2/c1",
            ]);
            assert.deepEqual(reg.workspacesForChannel("feishu"), ["im://feishu/u1/c1"]);
            assert.deepEqual(reg.workspacesForChannel("nope"), []);
        });

        it("invalidateImWorkspaces disposes every tracked workspace for the channel", async () => {
            const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
            const disposed: string[] = [];
            server.disposeWorkspace = async (cwd) => {
                disposed.push(cwd);
            };
            server.channelRegistry.trackWorkspace("wechat", "im://wechat/u1/c1");
            server.channelRegistry.trackWorkspace("wechat", "im://wechat/u2/c1");
            server.channelRegistry.trackWorkspace("feishu", "im://feishu/u1/c1");

            await server.invalidateImWorkspaces("wechat");

            assert.deepEqual(disposed.sort(), ["im://wechat/u1/c1", "im://wechat/u2/c1"]);
        });

        it("invalidateImWorkspaces on an unknown channel is a no-op", async () => {
            const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
            let disposed = 0;
            server.disposeWorkspace = async () => {
                disposed++;
            };
            await server.invalidateImWorkspaces("nope");
            assert.equal(disposed, 0);
        });

        it("emits im.workspaces_invalidated BEFORE disposing each workspace", async () => {
            const events: ("emit" | "dispose")[] = [];
            const transport = {
                open: async () => {},
                send: async () => {
                    events.push("emit");
                },
                onRequest: () => {},
                close: async () => {},
            };
            const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
            server.disposeWorkspace = async () => {
                events.push("dispose");
            };
            // invalidateImWorkspaces emits via emitPush -> getTransport().send.
            (server as unknown as { transport: typeof transport }).transport = transport;
            server.channelRegistry.trackWorkspace("wechat", "im://wechat/u1/c1");
            server.channelRegistry.trackWorkspace("wechat", "im://wechat/u2/c1");

            await server.invalidateImWorkspaces("wechat");

            // The notice loop must land before the dispose loop starts, so the
            // first dispose is never preceded by an earlier dispose (all notices
            // precede all disposes).
            const firstDispose = events.indexOf("dispose");
            assert.notEqual(firstDispose, -1, "workspaces are still disposed");
            assert.equal(
                events.slice(0, firstDispose).every((e) => e === "emit"),
                true,
            );
            assert.equal(events.filter((e) => e === "emit").length, 2, "one notice per workspace");
        });

        // End-to-end: a policy write must drop every cached workspace for the
        // channel, and disposeWorkspace itself must clean the reverse index.
        // The test bypasses the disposeWorkspace spy (which would skip the real
        // cleanup) by wiring up minimal real workspaces.
        it("policy write disposes cached workspaces and cleans the reverse index", async () => {
            const { server, workspaces } = makeServerWithRegistry();
            // Replace the heavy WorkspaceRuntime constructor with a tiny stub so
            // we can exercise the real disposeWorkspace + the real
            // untrackWorkspace call it does.
            const fake = { dispose: async () => {} } as unknown as WorkspaceRuntime;
            for (const key of ["im://wechat/u1/c1", "im://wechat/u2/c1"]) {
                server.channelRegistry.trackWorkspace("wechat", key);
                workspaces.publish(asWorkspaceId(key), fake);
            }
            server.channelRegistry.trackWorkspace("feishu", "im://feishu/u1/c1");
            workspaces.publish(asWorkspaceId("im://feishu/u1/c1"), fake);

            await server.setImChannelDefault("wechat", { tools: { shell: "allow" } });

            assert.deepEqual(
                server.channelRegistry.workspacesForChannel("wechat"),
                [],
                "wechat workspace keys must be cleared",
            );
            assert.deepEqual(server.channelRegistry.workspacesForChannel("feishu"), [
                "im://feishu/u1/c1",
            ]);
        });

        it("untrackWorkspace removes a single key (used by disposeWorkspace cleanup)", () => {
            const reg = new ChannelRegistry();
            reg.trackWorkspace("wechat", "im://wechat/u1/c1");
            reg.trackWorkspace("wechat", "im://wechat/u2/c1");
            reg.untrackWorkspace("wechat", "im://wechat/u1/c1");
            assert.deepEqual(reg.workspacesForChannel("wechat"), ["im://wechat/u2/c1"]);
            // idempotent
            reg.untrackWorkspace("wechat", "im://wechat/u1/c1");
            assert.deepEqual(reg.workspacesForChannel("wechat"), ["im://wechat/u2/c1"]);
        });
    });
});
