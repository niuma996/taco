/**
 * WeCom (企业微信) aibot channel manifest. Same conservative length budget as
 * wechat — verify against the aibot markdown content cap on bump; 2048 is the
 * well-tested envelope used by channelReply's chunker.
 */
import { CHANNEL_NAME_WECOM } from "../channelNames.ts";
import type { ChannelManifest } from "../types.ts";

const WECOM_MAX_MESSAGE_LENGTH = 2048;

export const wecomChannelManifest: ChannelManifest = {
    name: CHANNEL_NAME_WECOM,
    version: "0.1.0",
    description:
        "WeCom (企业微信) smart-bot channel over the official aibot WebSocket SDK. Bind by pasting botId + secret from the admin console (no QR flow). Requires the optional @wecom/aibot-node-sdk dependency.",
    capabilities: {
        maxMessageLength: WECOM_MAX_MESSAGE_LENGTH,
        requiresPersistentProcess: true,
        approvalButton: false,
    },
};
