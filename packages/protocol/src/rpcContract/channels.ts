/**
 * RPC contract rows — channels.* / imPolicy.* — IM channel instances and their policy layers.
 *
 * Three tables move together: the wire name, the params/result types, and the
 * params schema. `rpcContract/index.ts` merges them into the single
 * `RPC` / `rpcContract` / `rpcSchemas` exports that the client and the
 * sidecar both read.
 *
 * Adding a method to this domain means adding one entry to each of the three
 * tables below — the compile-time assertions in the index catch a row that
 * was added to one and forgotten in another.
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
    ChannelsRetryResult,
    ChannelsSubmitVerifyCodeParams,
    ChannelsSubmitVerifyCodeResult,
    ChannelsUnbindParams,
    ChannelsUnbindResult,
} from "../channels.js";

import type {
    ImPolicyClearChatOverrideParams,
    ImPolicyGetParams,
    ImPolicyGetResult,
    ImPolicySetChannelDefaultParams,
    ImPolicySetChatOverrideParams,
    ImPolicyWriteResult,
} from "../imPolicy.js";
import {
    channelsBindSchema,
    channelsCreateSchema,
    channelsListConversationsSchema,
    channelsListSchema,
    channelsRetrySchema,
    channelsSubmitVerifyCodeSchema,
    channelsUnbindSchema,
    imPolicyClearChatOverrideSchema,
    imPolicyGetSchema,
    imPolicySetChannelDefaultSchema,
    imPolicySetChatOverrideSchema,
} from "../schemas/index.js";
import type { RpcContractRow } from "./types.js";

/** Wire names for this domain. */
export const channelsMethods = {
    channelsList: "channels.list",
    channelsListConversations: "channels.listConversations",
    channelsCreate: "channels.create",
    channelsBind: "channels.bind",
    channelsSubmitVerifyCode: "channels.submitVerifyCode",
    channelsUnbind: "channels.unbind",
    channelsRetry: "channels.retry",
    // imPolicy.* — IM workspace policy admin (process-level).
    imPolicyGet: "imPolicy.get",
    imPolicySetChannelDefault: "imPolicy.setChannelDefault",
    imPolicySetChatOverride: "imPolicy.setChatOverride",
    imPolicyClearChatOverride: "imPolicy.clearChatOverride",
    // tools.*
} as const;

/** Params/result types and routing scope for this domain. */
export const channelsContract = {
    channelsList: { scope: "process" } as RpcContractRow<ChannelsListParams, ChannelsListResult>,
    channelsListConversations: { scope: "process" } as RpcContractRow<
        ChannelsListConversationsParams,
        ChannelsListConversationsResult
    >,
    channelsCreate: { scope: "process" } as RpcContractRow<
        ChannelsCreateParams,
        ChannelsCreateResult
    >,
    channelsBind: { scope: "process" } as RpcContractRow<ChannelsBindParams, ChannelsBindResult>,
    channelsSubmitVerifyCode: { scope: "process" } as RpcContractRow<
        ChannelsSubmitVerifyCodeParams,
        ChannelsSubmitVerifyCodeResult
    >,
    channelsUnbind: { scope: "process" } as RpcContractRow<
        ChannelsUnbindParams,
        ChannelsUnbindResult
    >,
    channelsRetry: { scope: "process" } as RpcContractRow<ChannelsRetryParams, ChannelsRetryResult>,
    imPolicyGet: { scope: "process" } as RpcContractRow<ImPolicyGetParams, ImPolicyGetResult>,
    imPolicySetChannelDefault: { scope: "process" } as RpcContractRow<
        ImPolicySetChannelDefaultParams,
        ImPolicyWriteResult
    >,
    imPolicySetChatOverride: { scope: "process" } as RpcContractRow<
        ImPolicySetChatOverrideParams,
        ImPolicyWriteResult
    >,
    imPolicyClearChatOverride: { scope: "process" } as RpcContractRow<
        ImPolicyClearChatOverrideParams,
        ImPolicyWriteResult
    >,
};

/** Params schemas for this domain. */
export const channelsSchemas = {
    channelsList: channelsListSchema,
    channelsListConversations: channelsListConversationsSchema,
    channelsCreate: channelsCreateSchema,
    channelsBind: channelsBindSchema,
    channelsSubmitVerifyCode: channelsSubmitVerifyCodeSchema,
    channelsUnbind: channelsUnbindSchema,
    channelsRetry: channelsRetrySchema,
    imPolicyGet: imPolicyGetSchema,
    imPolicySetChannelDefault: imPolicySetChannelDefaultSchema,
    imPolicySetChatOverride: imPolicySetChatOverrideSchema,
    imPolicyClearChatOverride: imPolicyClearChatOverrideSchema,
};
