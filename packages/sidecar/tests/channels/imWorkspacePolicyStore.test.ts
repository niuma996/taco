import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
    chatPolicyKey,
    DEFAULT_IM_WORKSPACE_POLICY,
} from "../../src/channels/imWorkspacePolicy.ts";
import { ImWorkspacePolicyStore } from "../../src/channels/imWorkspacePolicyStore.ts";

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
        assert.deepEqual(resolved.executionDir, { mode: "per-chat" }, "sibling overrides survive");
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
            JSON.stringify({ default: { perChatScratch: true }, chats: { [otherKey]: badChat } }),
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
