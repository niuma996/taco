import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ServerPush } from "@taco-ai/protocol";
import type { MockChannelHandle } from "../../src/channels/builtin/mockChannel.ts";
import { MockChannel } from "../../src/channels/builtin/mockChannel.ts";
import { ChannelRegistry, validateChannelInstanceId } from "../../src/channels/registry.ts";
import type {
    Channel,
    ChannelContext,
    ChannelHandle,
    ChannelManifest,
} from "../../src/channels/types.ts";

function frame(method: string): ServerPush {
    return { method, workspace: "w", session: "s", params: {} } as unknown as ServerPush;
}

const mockManifest: ChannelManifest = {
    name: "mock",
    version: "0.1.0",
    capabilities: { maxMessageLength: 4096 },
};

function failingResolver(): Channel {
    throw new Error("unknown channel manifest: nope");
}

describe("ChannelRegistry", () => {
    it("loadAndStart reports failed channels without throwing", async () => {
        const registry = new ChannelRegistry();
        const result = await registry.loadAndStart(
            [{ channelId: "bad-1", manifest: mockManifest, config: {} }],
            failingResolver,
            () => {
                throw new Error("ctx");
            },
        );
        assert.equal(result.failed.length, 1);
        assert.equal(result.failed[0].channelId, "bad-1");
        assert.match(result.failed[0].error, /unknown channel manifest/);
    });

    it("loadAndStart resolves the Channel via the factory from manifest.name", async () => {
        const registry = new ChannelRegistry();
        const result = await registry.loadAndStart(
            [{ channelId: "mock-1", manifest: mockManifest, config: {} }],
            () => new MockChannel(),
            () => ({}) as ChannelContext,
        );
        assert.deepEqual(result.started, ["mock-1"]);
        assert.deepEqual(result.failed, []);
        assert.ok(registry.has("mock-1"));
    });

    it("loadAndStart hands each channel its own taco.json config block", async () => {
        const registry = new ChannelRegistry();
        const seen: { channelId: string; config: Record<string, unknown> }[] = [];
        await registry.loadAndStart(
            [{ channelId: "mock-1", manifest: mockManifest, config: { appId: "a1" } }],
            () => new MockChannel(),
            (channelId, config) => {
                seen.push({ channelId, config });
                return {} as ChannelContext;
            },
        );
        assert.deepEqual(seen, [{ channelId: "mock-1", config: { appId: "a1" } }]);
    });

    it("push delivers frames to the registered channel in order", async () => {
        const registry = new ChannelRegistry();
        const channel = new MockChannel();
        const handle = (await channel.start({} as ChannelContext)) as MockChannelHandle;
        registry.register("mock-1", channel, handle);
        registry.push("mock-1", frame("a"));
        registry.push("mock-1", frame("b"));
        await handle.waitForFrameCount(2);
        const received = handle.receivedFrames;
        assert.deepEqual(
            received.map((f) => f.method),
            ["a", "b"],
        );
    });

    it("stop drains pending pushes before closing the handle", async () => {
        const registry = new ChannelRegistry();
        const channel = new MockChannel();
        let closed = false;
        let releasePush!: () => void;
        const gate = new Promise<void>((resolve) => {
            releasePush = resolve;
        });
        const handle: ChannelHandle = {
            push: async () => {
                await gate;
            },
            close: async () => {
                closed = true;
            },
        };
        registry.register("mock-1", channel, handle);
        registry.push("mock-1", frame("a"));
        const stopping = registry.stop("mock-1");
        // stop() is in-flight; close must not have run while the push is pending.
        assert.equal(closed, false);
        releasePush();
        await stopping;
        assert.equal(closed, true);
        assert.equal(registry.has("mock-1"), false);
    });

    it("trackWorkspace associates im workspaces with a channel", () => {
        const registry = new ChannelRegistry();
        registry.trackWorkspace("mock-1", "im://mock-1/u1/c1");
        // Internal association asserted indirectly via stop cleanup; P0 only verifies no throw
    });

    it("push silently ignores non-existent channelId", () => {
        const registry = new ChannelRegistry();
        registry.push("nonexistent", frame("x")); // must not throw
    });

    it("validateChannelInstanceId rejects invalid channelIds", () => {
        assert.equal(
            validateChannelInstanceId({ channelId: "ok-1", manifest: mockManifest, config: {} }),
            undefined,
        );
        assert.match(
            validateChannelInstanceId({
                channelId: "Bad/ID",
                manifest: mockManifest,
                config: {},
            }) ?? "",
            /invalid channelId/,
        );
        assert.match(
            validateChannelInstanceId({ channelId: "", manifest: mockManifest, config: {} }) ?? "",
            /invalid channelId/,
        );
    });
});
