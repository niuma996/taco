import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { ChannelRegistry } from "../../src/channels/registry.ts";
import { ProviderKeyStore } from "../../src/runtime/providerKeyStore.ts";
import type { WorkspaceRuntime } from "../../src/runtime/workspace.ts";
import { SidecarServer } from "../../src/server/server.ts";

describe("policy invalidation", () => {
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
        const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
        // Replace the heavy WorkspaceRuntime constructor with a tiny stub so
        // we can exercise the real disposeWorkspace + the real
        // untrackWorkspace call it does.
        const fake = { dispose: async () => {} } as unknown as WorkspaceRuntime;
        // workspaceMap is private; cast through unknown to reach it for setup.
        const wm = (server as unknown as { workspaceMap: Map<string, WorkspaceRuntime> })
            .workspaceMap;
        for (const key of ["im://wechat/u1/c1", "im://wechat/u2/c1"]) {
            server.channelRegistry.trackWorkspace("wechat", key);
            wm.set(key, fake);
        }
        server.channelRegistry.trackWorkspace("feishu", "im://feishu/u1/c1");
        wm.set("im://feishu/u1/c1", fake);

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
