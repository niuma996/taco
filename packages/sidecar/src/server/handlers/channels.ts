/**
 * channels.* handlers — IM channel listing and binding.
 *
 * Credentials never appear in a result: `configured` is a boolean and the
 * token stays in the channel's own state file.
 */

import type {
    ChannelsBindParams,
    ChannelsBindResult,
    ChannelsCreateParams,
    ChannelsCreateResult,
    ChannelsListConversationsParams,
    ChannelsListConversationsResult,
    ChannelsListParams,
    ChannelsListResult,
    ChannelsRetryParams,
    ChannelsSubmitVerifyCodeParams,
    ChannelsSubmitVerifyCodeResult,
    ChannelsUnbindParams,
    ChannelsUnbindResult,
} from "@taco-ai/protocol";
import {
    channelsBindSchema,
    channelsCreateSchema,
    channelsListConversationsSchema,
    channelsListSchema,
    channelsRetrySchema,
    channelsSubmitVerifyCodeSchema,
    channelsUnbindSchema,
    ErrorCodes,
} from "@taco-ai/protocol";
import { RPC } from "@taco-ai/shared";
import { WechatSdkMissingError, WecomSdkMissingError } from "../../channels/channelFactory.ts";
import type { ChannelControl, ServerRpcSurface } from "../../runtime/serverRpcSurface.ts";
import { type MethodCtx, RpcHandlerError, registerMethod } from "../methodRegistry.ts";

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

function requireChannelId(value: unknown): string {
    if (typeof value !== "string" || value.length === 0) {
        throw new RpcHandlerError(ErrorCodes.InvalidParams, "channelId is required");
    }
    return value;
}

export function registerChannelsHandlers(): void {
    registerMethod(
        RPC.channelsList,
        false,
        async ({ server }: MethodCtx<ChannelsListParams>) =>
            requireChannels(server).list() satisfies ChannelsListResult,
        { schema: channelsListSchema },
    );

    registerMethod(
        RPC.channelsListConversations,
        false,
        async ({ server, params }: MethodCtx<ChannelsListConversationsParams>) => {
            const channelId =
                typeof params?.channelId === "string" && params.channelId.length > 0
                    ? params.channelId
                    : undefined;
            return requireChannels(server).listConversations(
                channelId,
            ) satisfies ChannelsListConversationsResult;
        },
        { schema: channelsListConversationsSchema },
    );

    registerMethod(
        RPC.channelsCreate,
        false,
        async ({ server, params }: MethodCtx<ChannelsCreateParams>) => {
            const channels = requireChannels(server);
            if (typeof params?.name !== "string" || params.name.length === 0) {
                throw new RpcHandlerError(ErrorCodes.InvalidParams, "name is required");
            }
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
        { command: true, schema: channelsCreateSchema },
    );

    registerMethod(
        RPC.channelsBind,
        false,
        async ({ server, params }: MethodCtx<ChannelsBindParams>) => {
            const channels = requireChannels(server);
            const channelId = requireChannelId(params?.channelId);
            try {
                return (await channels.bind(
                    channelId,
                    params?.force,
                    params?.creds,
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
        { command: true, schema: channelsBindSchema },
    );

    registerMethod(
        RPC.channelsSubmitVerifyCode,
        false,
        async ({ server, params }: MethodCtx<ChannelsSubmitVerifyCodeParams>) => {
            const channels = requireChannels(server);
            if (typeof params?.requestId !== "string" || params.requestId.length === 0) {
                throw new RpcHandlerError(ErrorCodes.InvalidParams, "requestId is required");
            }
            if (typeof params?.code !== "string" || params.code.length === 0) {
                throw new RpcHandlerError(ErrorCodes.InvalidParams, "code is required");
            }
            return {
                accepted: channels.submitVerifyCode(params.requestId, params.code),
            } satisfies ChannelsSubmitVerifyCodeResult;
        },
        { command: true, schema: channelsSubmitVerifyCodeSchema },
    );

    registerMethod(
        RPC.channelsUnbind,
        false,
        async ({ server, params }: MethodCtx<ChannelsUnbindParams>) => {
            const channels = requireChannels(server);
            const channelId = requireChannelId(params?.channelId);
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
        { command: true, schema: channelsUnbindSchema },
    );

    registerMethod(
        RPC.channelsRetry,
        false,
        async ({ server, params }: MethodCtx<ChannelsRetryParams>) => {
            const channels = requireChannels(server);
            const channelId = requireChannelId(params?.channelId);
            try {
                return await channels.retry(channelId);
            } catch (e) {
                throw new RpcHandlerError(
                    ErrorCodes.InvalidParams,
                    e instanceof Error ? e.message : String(e),
                );
            }
        },
        { command: true, schema: channelsRetrySchema },
    );
}
