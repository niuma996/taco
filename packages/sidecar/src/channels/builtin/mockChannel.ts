import type { ServerPush } from "@taco-ai/protocol";
import { CHANNEL_NAME_MOCK } from "../channelNames.ts";
import type { Channel, ChannelContext, ChannelHandle, ChannelManifest } from "../types.ts";

export const mockChannelManifest: ChannelManifest = {
    name: CHANNEL_NAME_MOCK,
    version: "0.1.0",
    description:
        "Test-only channel. Inbound driven by tests via ctx.ingress.submit(); push frames stored in memory for assertions.",
    capabilities: { maxMessageLength: 4096 },
    configSchema: [],
};

export class MockChannel implements Channel {
    readonly manifest = mockChannelManifest;
    async start(_ctx: ChannelContext): Promise<ChannelHandle> {
        return new MockChannelHandle();
    }
}

export class MockChannelHandle implements ChannelHandle {
    private readonly _receivedFrames: ServerPush[] = [];
    private waiters: { target: number; resolve: () => void }[] = [];

    /** Read-only view of received frames (for test assertions; replaces private field access). */
    get receivedFrames(): readonly ServerPush[] {
        return this._receivedFrames;
    }

    async push(frame: ServerPush): Promise<void> {
        this._receivedFrames.push(frame);
        this.waiters = this.waiters.filter((w) => {
            if (this._receivedFrames.length >= w.target) {
                w.resolve();
                return false;
            }
            return true;
        });
    }

    async close(): Promise<void> {}

    /** Event-triggered wait for a frame count (not polling). Consistent with InMemoryTransport.waitForPushCount. */
    async waitForFrameCount(target: number, timeoutMs = 2000): Promise<void> {
        if (this.receivedFrames.length >= target) return;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(
                () =>
                    reject(
                        new Error(
                            `timeout waiting for ${target} frames, got ${this.receivedFrames.length}`,
                        ),
                    ),
                timeoutMs,
            );
            this.waiters.push({
                target,
                resolve: () => {
                    clearTimeout(timer);
                    resolve();
                },
            });
        });
    }
}
