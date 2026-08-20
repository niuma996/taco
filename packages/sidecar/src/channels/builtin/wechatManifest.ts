import { CHANNEL_NAME_WECHAT } from "../channelNames.ts";
import type { ChannelManifest } from "../types.ts";

/** iLink caps a text message well below this; chunking keeps a safety margin. */
const WECHAT_MAX_MESSAGE_LENGTH = 2048;

export const wechatChannelManifest: ChannelManifest = {
    name: CHANNEL_NAME_WECHAT,
    version: "0.1.0",
    description:
        "WeChat personal-account bot over the official iLink API. Requires the optional @wechatbot/wechatbot dependency at runtime (see README 'IM Channels').",
    capabilities: {
        maxMessageLength: WECHAT_MAX_MESSAGE_LENGTH,
        requiresPersistentProcess: true,
        approvalButton: false,
    },
    // Credentials come from the QR bind flow and live in ChannelConfigStore,
    // never in taco.json.
};
