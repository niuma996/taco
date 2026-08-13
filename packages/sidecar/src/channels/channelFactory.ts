import { MockChannel } from "./builtin/mockChannel.ts";
import type { PeerResolver } from "./builtin/wechatChannel.ts";
import type { ChannelBindBroker } from "./channelBindBroker.ts";
import { CHANNEL_NAME_MOCK, CHANNEL_NAME_WECHAT } from "./channelNames.ts";
import type { Channel } from "./types.ts";

/** Dependencies real channels need beyond their ChannelContext. Optional so
 *  tests can construct a factory that only resolves `mock`. */
export interface ChannelFactoryDeps {
    broker: ChannelBindBroker;
    resolvePeer: PeerResolver;
    /** Optional: peers routed through a channel, for broadcasting workspace-
     *  dimensioned notices (e.g. the policy interrupt notice) to all peers. */
    listPeers?: (channelId: string) => string[];
}

/** Thrown by create("wechat") when the @wechatbot/wechatbot SDK is not installed. */
export class WechatSdkMissingError extends Error {
    constructor(cause: unknown) {
        super(
            "wechat channel requires the @wechatbot/wechatbot optional dependency; install it with `pnpm add @wechatbot/wechatbot@2.2.0`",
        );
        this.name = "WechatSdkMissingError";
        this.cause = cause;
    }
}

/**
 * Registry-boundary factory. The manifest is attached to the Channel by the registry, not by the Channel itself.
 *
 * `create("wechat")` is async and dynamic-imports the WeChat channel module
 * (which in turn pulls in `@wechatbot/wechatbot`). The dependency is declared
 * `optionalDependencies` in package.json so installs without it succeed; the
 * SDK is only required when a user actually instantiates a wechat channel.
 */
export class ChannelFactory {
    constructor(private readonly deps?: ChannelFactoryDeps) {}

    /**
     * @throws when the manifest name is unknown, when the factory was built
     *         without deps and a real channel is requested, or when the
     *         wechat channel's SDK is missing.
     */
    async create(manifestName: string): Promise<Channel> {
        switch (manifestName) {
            case CHANNEL_NAME_MOCK:
                return new MockChannel();
            case CHANNEL_NAME_WECHAT: {
                if (!this.deps) {
                    throw new Error(`channel ${manifestName} requires factory dependencies`);
                }
                let mod: typeof import("./builtin/wechatChannel.ts");
                try {
                    mod = await import("./builtin/wechatChannel.ts");
                } catch (e) {
                    // Re-throw as a coded error so the desktop can offer
                    // a one-click "install SDK" hint instead of a stack trace.
                    throw new WechatSdkMissingError(e);
                }
                return new mod.WeChatChannel({
                    broker: this.deps.broker,
                    resolvePeer: this.deps.resolvePeer,
                    listPeers: this.deps.listPeers,
                });
            }
            default:
                throw new Error(`unknown channel manifest: ${manifestName}`);
        }
    }
}
