/**
 * channels.* handlers — IM channel listing and binding.
 *
 * Credentials never appear in a result: `configured` is a boolean and the
 * token stays in the channel's own state file.
 */

import type {
    ChannelsBindResult,
    ChannelsCreateResult,
    ChannelsListConversationsResult,
    ChannelsListResult,
    ChannelsSubmitVerifyCodeResult,
    ChannelsUnbindResult,
} from "@taco-ai/protocol";
import { ErrorCodes } from "@taco-ai/protocol";
import { WechatSdkMissingError, WecomSdkMissingError } from "../../channels/channelFactory.ts";
import type { ChannelControl, ServerRpcSurface } from "../../runtime/serverRpcSurface.ts";
import { RpcHandlerError, registerMethod } from "../methodRegistry.ts";

/** Channels are wired at startup; absent means this host does not support them. */
function requireChannels(server: ServerRpcSurface): ChannelControl {
    if (!server.channels) {
        throw new RpcHandlerError(
            ErrorCodes.InvalidState,
            "channels are not available on this server",
        );
    }
    return server.channels;
}

export function registerChannelsHandlers(): void {
    registerMethod(
        "channelsList",
        false,
        async ({ server }) => requireChannels(server).list() satisfies ChannelsListResult,
    );

    registerMethod("channelsListConversations", false, async ({ server, params }) => {
        const channelId = params.channelId;
        return requireChannels(server).listConversations(
            channelId,
        ) satisfies ChannelsListConversationsResult;
    });

    registerMethod(
        "channelsCreate",
        false,
        async ({ server, params }) => {
            const channels = requireChannels(server);
            try {
                return channels.create(
                    params.name,
                    params.channelId,
                ) satisfies ChannelsCreateResult;
            } catch (e) {
                // Unknown type / duplicate id / bad id are all caller errors.
                throw new RpcHandlerError(
                    ErrorCodes.InvalidParams,
                    e instanceof Error ? e.message : String(e),
                );
            }
        },
        { command: true },
    );

    registerMethod(
        "channelsBind",
        false,
        async ({ server, params }) => {
            const channels = requireChannels(server);
            const channelId = params.channelId;
            try {
                return (await channels.bind(
                    channelId,
                    params.force,
                    params.creds,
                )) satisfies ChannelsBindResult;
            } catch (e) {
                if (e instanceof WechatSdkMissingError) {
                    throw new RpcHandlerError(ErrorCodes.WechatSdkMissing, e.message);
                }
                if (e instanceof WecomSdkMissingError) {
                    throw new RpcHandlerError(ErrorCodes.WecomSdkMissing, e.message);
                }
                // Unknown / not-running are caller mistakes, not server faults;
                // normalizeError would otherwise flatten them to `internal`.
                throw new RpcHandlerError(
                    ErrorCodes.InvalidParams,
                    e instanceof Error ? e.message : String(e),
                );
            }
        },
        { command: true },
    );

    registerMethod(
        "channelsSubmitVerifyCode",
        false,
        async ({ server, params }) => {
            const channels = requireChannels(server);
            return {
                accepted: channels.submitVerifyCode(params.requestId, params.code),
            } satisfies ChannelsSubmitVerifyCodeResult;
        },
        { command: true },
    );

    registerMethod(
        "channelsUnbind",
        false,
        async ({ server, params }) => {
            const channels = requireChannels(server);
            const channelId = params.channelId;
            try {
                await channels.unbind(channelId);
            } catch (e) {
                throw new RpcHandlerError(
                    ErrorCodes.InvalidParams,
                    e instanceof Error ? e.message : String(e),
                );
            }
            return { channelId } satisfies ChannelsUnbindResult;
        },
        { command: true },
    );

    registerMethod(
        "channelsRetry",
        false,
        async ({ server, params }) => {
            const channels = requireChannels(server);
            const channelId = params.channelId;
            try {
                return await channels.retry(channelId);
            } catch (e) {
                throw new RpcHandlerError(
                    ErrorCodes.InvalidParams,
                    e instanceof Error ? e.message : String(e),
                );
            }
        },
        { command: true },
    );
}
