/**
 * RPC contract rows — channels.* / imPolicy.* — IM channel instances and their policy layers.
 *
 * Each method is declared once as a row (wire name, scope, params/result
 * types, schema); `rpcContract/index.ts` derives the `RPC` / `rpcContract` /
 * `rpcSchemas` tables from those rows.
 */

import type {
    ChannelsBindResult,
    ChannelsCreateResult,
    ChannelsListConversationsResult,
    ChannelsListResult,
    ChannelsRetryResult,
    ChannelsSubmitVerifyCodeResult,
    ChannelsUnbindResult,
} from "../channels.js";

import type { ImPolicyGetResult, ImPolicyWriteResult } from "../imPolicy.js";
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
    channelsList: row<ChannelsListResult>()("channels.list", "process", channelsListSchema),
    channelsListConversations: row<ChannelsListConversationsResult>()(
        "channels.listConversations",
        "process",
        channelsListConversationsSchema,
    ),
    channelsCreate: row<ChannelsCreateResult>()("channels.create", "process", channelsCreateSchema),
    channelsBind: row<ChannelsBindResult>()("channels.bind", "process", channelsBindSchema),
    channelsSubmitVerifyCode: row<ChannelsSubmitVerifyCodeResult>()(
        "channels.submitVerifyCode",
        "process",
        channelsSubmitVerifyCodeSchema,
    ),
    channelsUnbind: row<ChannelsUnbindResult>()("channels.unbind", "process", channelsUnbindSchema),
    channelsRetry: row<ChannelsRetryResult>()("channels.retry", "process", channelsRetrySchema),
    imPolicyGet: row<ImPolicyGetResult>()("imPolicy.get", "process", imPolicyGetSchema),
    imPolicySetChannelDefault: row<ImPolicyWriteResult>()(
        "imPolicy.setChannelDefault",
        "process",
        imPolicySetChannelDefaultSchema,
    ),
    imPolicySetChatOverride: row<ImPolicyWriteResult>()(
        "imPolicy.setChatOverride",
        "process",
        imPolicySetChatOverrideSchema,
    ),
    imPolicyClearChatOverride: row<ImPolicyWriteResult>()(
        "imPolicy.clearChatOverride",
        "process",
        imPolicyClearChatOverrideSchema,
    ),
};

export const channelsMethods = domainMethods(channelsRows);
export const channelsContract = domainContract(channelsRows);
export const channelsSchemas = domainSchemas(channelsRows);
