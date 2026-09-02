import { MockChannel } from "./builtin/mockChannel.ts";
import type { ChannelBindBroker } from "./channelBindBroker.ts";
import { CHANNEL_NAME_MOCK, CHANNEL_NAME_WECHAT, CHANNEL_NAME_WECOM } from "./channelNames.ts";
import type { Channel, ChannelRouteResolver } from "./types.ts";

/** Dependencies real channels need beyond their ChannelContext. Optional so
 *  tests can construct a factory that only resolves `mock`. */
export interface ChannelFactoryDeps {
    broker: ChannelBindBroker;
    /** Resolves the IM route triple (channelId, peerId, chatId) for a session
     *  so a push frame can address the platform peer; also drives broadcast
     *  routing on channels that implement listPeers. */
    resolveRoute: ChannelRouteResolver;
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

/** Thrown by create("wecom") when the @wecom/aibot-node-sdk SDK is not installed. */
export class WecomSdkMissingError extends Error {
    constructor(cause: unknown) {
        super(
            "wecom channel requires the @wecom/aibot-node-sdk optional dependency; install it with `pnpm add @wecom/aibot-node-sdk@1.0.7`",
        );
        this.name = "WecomSdkMissingError";
        this.cause = cause;
    }
}

/**
 * Registry-boundary factory. The manifest is attached to the Channel by the registry, not by the Channel itself.
 *
 * `create("wechat")` is async and dynamic-imports the WeChat channel module
 * (which in turn pulls in `@wechatbot/wechatbot`); the same pattern is used
 * for `create("wecom")` and `@wecom/aibot-node-sdk`. Both dependencies are
 * declared `optionalDependencies` in package.json so installs without them
 * succeed; the SDK is only required when a user actually instantiates the
 * channel. A failed dynamic import is converted into a coded SDK-missing
 * error so the desktop can offer a one-click install hint.
 */
export class ChannelFactory {
    constructor(private readonly deps?: ChannelFactoryDeps) {}

    /**
     * @throws when the manifest name is unknown, when the factory was built
     *         without deps and a real channel is requested, or when the
     *         channel's SDK is missing.
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
                    throw new WechatSdkMissingError(e);
                }
                return new mod.WeChatChannel({
                    broker: this.deps.broker,
                    resolveRoute: this.deps.resolveRoute,
                    listPeers: this.deps.listPeers,
                });
            }
            case CHANNEL_NAME_WECOM: {
                if (!this.deps) {
                    throw new Error(`channel ${manifestName} requires factory dependencies`);
                }
                let mod: typeof import("./builtin/wecomChannel.ts");
                try {
                    mod = await import("./builtin/wecomChannel.ts");
                } catch (e) {
                    throw new WecomSdkMissingError(e);
                }
                return new mod.WeComChannel({
                    broker: this.deps.broker,
                    resolveRoute: this.deps.resolveRoute,
                });
            }
            default:
                throw new Error(`unknown channel manifest: ${manifestName}`);
        }
    }
}
