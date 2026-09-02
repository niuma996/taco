/**
 * Built-in channel manifest names, resolved by ChannelFactory. External
 * channels (feishu / wecom) are P1; unknown names are reported as failed
 * starts.
 *
 * Deliberately NOT derived from `BUILTIN_CHANNEL_MANIFESTS`: that list
 * excludes `mock` (test-only, must not appear in the UI catalogue), while the
 * factory still needs to resolve it. Deriving here would create a cycle
 * (channelNames → builtinManifests → wechatManifest → channelNames). The
 * reverse derivation is equally unsafe: building `BUILTIN_CHANNEL_MANIFESTS`
 * from these names would pull the manifests back into this module's import
 * graph. Keep the literal list and the manifests as separate sources of truth.
 */
export const CHANNEL_NAME_MOCK = "mock";
export const CHANNEL_NAME_WECHAT = "wechat";
export const CHANNEL_NAME_WECOM = "wecom";
export const BUILTIN_CHANNEL_NAMES: readonly string[] = [
    CHANNEL_NAME_MOCK,
    CHANNEL_NAME_WECHAT,
    CHANNEL_NAME_WECOM,
];
