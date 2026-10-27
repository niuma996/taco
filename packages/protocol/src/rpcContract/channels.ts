/**
 * RPC contract rows — channels.* / imPolicy.* — IM channel instances and their policy layers.
 *
 * Each method is declared once as a row (wire name, scope, params/result
 * types, schema); `rpcContract/index.ts` derives the `RPC` / `rpcContract` /
 * `rpcSchemas` tables from those rows.
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
import { domainContract, domainMethods, domainSchemas, row } from "./types.js";

const channelsRows = {
    channelsList: row<ChannelsListParams, ChannelsListResult>()(
        "channels.list",
        "process",
        channelsListSchema,
    ),
    channelsListConversations: row<
        ChannelsListConversationsParams,
        ChannelsListConversationsResult
    >()("channels.listConversations", "process", channelsListConversationsSchema),
    channelsCreate: row<ChannelsCreateParams, ChannelsCreateResult>()(
        "channels.create",
        "process",
        channelsCreateSchema,
    ),
    channelsBind: row<ChannelsBindParams, ChannelsBindResult>()(
        "channels.bind",
        "process",
        channelsBindSchema,
    ),
    channelsSubmitVerifyCode: row<ChannelsSubmitVerifyCodeParams, ChannelsSubmitVerifyCodeResult>()(
        "channels.submitVerifyCode",
        "process",
        channelsSubmitVerifyCodeSchema,
    ),
    channelsUnbind: row<ChannelsUnbindParams, ChannelsUnbindResult>()(
        "channels.unbind",
        "process",
        channelsUnbindSchema,
    ),
    channelsRetry: row<ChannelsRetryParams, ChannelsRetryResult>()(
        "channels.retry",
        "process",
        channelsRetrySchema,
    ),
    imPolicyGet: row<ImPolicyGetParams, ImPolicyGetResult>()(
        "imPolicy.get",
        "process",
        imPolicyGetSchema,
    ),
    imPolicySetChannelDefault: row<ImPolicySetChannelDefaultParams, ImPolicyWriteResult>()(
        "imPolicy.setChannelDefault",
        "process",
        imPolicySetChannelDefaultSchema,
    ),
    imPolicySetChatOverride: row<ImPolicySetChatOverrideParams, ImPolicyWriteResult>()(
        "imPolicy.setChatOverride",
        "process",
        imPolicySetChatOverrideSchema,
    ),
    imPolicyClearChatOverride: row<ImPolicyClearChatOverrideParams, ImPolicyWriteResult>()(
        "imPolicy.clearChatOverride",
        "process",
        imPolicyClearChatOverrideSchema,
    ),
};

export const channelsMethods = domainMethods(channelsRows);
export const channelsContract = domainContract(channelsRows);
export const channelsSchemas = domainSchemas(channelsRows);
