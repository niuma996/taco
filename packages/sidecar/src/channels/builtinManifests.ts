/**
 * Manifests of the built-in channels, for `channels.list` to advertise what can
 * be instantiated. Separate from channelFactory so reading the catalogue does
 * not construct channels or pull in their SDKs.
 *
 * The WeChat manifest is registered eagerly so `channels.list` can advertise
 * the type even when the SDK is not installed — channelFactory.create does the
 * actual SDK load and reports `wechat_sdk_missing` to the client if it fails.
 * `mock` is omitted: it is test-only and must not appear in the UI.
 *
 * NOTE: when @wechatbot/wechatbot is uninstalled, WeChat is still advertised
 * but `channels.bind` will fail with `wechat_sdk_missing`. The desktop is
 * expected to show this in the ChannelsPane and let the user opt into
 * installing the SDK.
 */

import { wechatChannelManifest } from "./builtin/wechatManifest.ts";
import { wecomChannelManifest } from "./builtin/wecomManifest.ts";
import type { ChannelManifest } from "./types.ts";

export const BUILTIN_CHANNEL_MANIFESTS: readonly ChannelManifest[] = [
    wechatChannelManifest,
    wecomChannelManifest,
];
