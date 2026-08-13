/**
 * settings.* handler — process-level config read/write (not workspace-scoped).
 *
 * The returned `global` never carries raw key material —
 * `anthropicApiKey` / `openaiApiKey` / `apiKeys.*` are converted via
 * `toView` to `MaskedKey`, so the client cache and inter-process RPC
 * frames never expose plaintext keys. (taco.json on disk still stores
 * plaintext — that is what the in-process toView masks.) Sync point
 * for this contract: `TacoGlobalConfigView` in `@taco-ai/protocol`.
 */

import type {
    ChannelInstanceConfigView,
    SettingsGetParams,
    SettingsWriteParams,
    TacoGlobalConfigShape,
    TacoGlobalConfigView,
} from "@taco-ai/protocol";
import { ErrorCodes, settingsGetSchema, settingsWriteSchema } from "@taco-ai/protocol";
import { RPC } from "@taco-ai/shared";
import { readGlobalConfig, saveGlobalConfig } from "../../config/config.ts";
import { type MethodCtx, RpcHandlerError, registerMethod } from "../methodRegistry.ts";
import { mcpServerToView } from "./mcpView.ts";

/**
 * Mask a single key string. Keeps the first 7 chars (covers known
 * provider prefixes like `sk-ant-` / `sk-cp-`) plus the last 4 chars,
 * joined with `…`. Length cutoff: at 13 chars the mask would reveal
 * 7 head + 4 tail = 11 of 13 (84%); below that head+tail overlap or
 * expose the full string, so short inputs degrade to
 * `configured: false` — the user can verify presence via the Settings
 * "Set / Replace" flow without the mask leaking the whole secret.
 */
export function maskKey(raw: string | undefined): {
    configured: boolean;
    mask?: string;
} {
    if (!raw || raw.length === 0) return { configured: false };
    const head = 7;
    const tail = 4;
    if (raw.length <= head + tail + 1) return { configured: false };
    return { configured: true, mask: `${raw.slice(0, head)}…${raw.slice(-tail)}` };
}

/**
 * Map a raw `ChannelInstanceConfig` to its safe view. The full `config` blob is
 * intentionally dropped because channel SDKs may store their own secrets in it
 * (a future extension channel could choose to keep API keys in `channels[i].config`).
 */
function channelInstanceToView(
    c: NonNullable<TacoGlobalConfigShape["channels"]>[number],
): ChannelInstanceConfigView {
    return {
        channelId: c.channelId,
        manifest: { ...c.manifest },
    };
}

/** Map a raw `TacoGlobalConfigShape` to its safe `TacoGlobalConfigView`. */
export function toView(raw: TacoGlobalConfigShape): TacoGlobalConfigView {
    const v: TacoGlobalConfigView = {
        commandPermissions: raw.commandPermissions,
        defaultModel: raw.defaultModel,
        defaultProvider: raw.defaultProvider,
        sessionsRoot: raw.sessionsRoot,
        systemPrompt: raw.systemPrompt,
        thinkingLevel: raw.thinkingLevel,
        extensions: raw.extensions,
        disabledExtensions: raw.disabledExtensions,
        compaction: raw.compaction,
        // These three are allowlisted, but each is then re-projected through
        // its own safe view (channelInstanceToView / mcpServerToView) so the
        // secret-bearing nested fields are stripped before the IPC frame
        // reaches the desktop cache. Omitting them entirely would leave the
        // settings panes (McpSection / ProviderSection / ChannelsPane) empty
        // even though taco.json on disk has entries.
        customProviders: raw.customProviders,
        channels: raw.channels?.map(channelInstanceToView),
        mcpServers: raw.mcpServers?.map(mcpServerToView),
        instructions: raw.instructions,
    };
    if (raw.anthropicApiKey !== undefined) v.anthropicApiKey = maskKey(raw.anthropicApiKey);
    if (raw.openaiApiKey !== undefined) v.openaiApiKey = maskKey(raw.openaiApiKey);
    if (raw.apiKeys) {
        v.apiKeys = Object.fromEntries(
            Object.entries(raw.apiKeys).map(([k, val]) => [k, maskKey(val)]),
        );
    }
    return v;
}

export function registerSettingsHandlers(): void {
    registerMethod(
        RPC.settingsGet,
        false,
        async ({ params }: MethodCtx<SettingsGetParams>) => {
            // params is currently unused; structure is kept for future
            // workspace-scoped layering.
            void params;
            return { global: toView(readGlobalConfig()) };
        },
        { schema: settingsGetSchema },
    );

    registerMethod(
        RPC.settingsWrite,
        false,
        async ({ params, server }: MethodCtx<SettingsWriteParams>) => {
            const { global: globalPatch } = params ?? {};
            if (!globalPatch || typeof globalPatch !== "object") {
                throw new RpcHandlerError(
                    ErrorCodes.InvalidParams,
                    "settings.write: global must be an object",
                );
            }
            try {
                // Accept raw patch (may include raw key strings for write),
                // persist as-is, but return a masked view.
                const next = saveGlobalConfig(globalPatch);
                // Hot-update apiKeys: push the latest merged apiKeys from disk
                // into ProviderKeyStore. pi reads keys lazily via
                // CredentialStore.read per provider id — no catalog recompute.
                if (globalPatch.apiKeys !== undefined) {
                    server.providerKeyStore.update(next.apiKeys ?? {});
                }
                // Replace custom providers: push to existing workspaces'
                // ModelRegistry for reconcile (add/remove custom ids, leave
                // built-ins alone); new workspaces read the latest on creation.
                // Only when the patch itself contains customProviders — since
                // saveGlobalConfig is a merge, an unrelated field write would
                // also make next.customProviders non-empty and trigger a
                // pointless push.
                if ("customProviders" in globalPatch) {
                    server.setCustomProviders?.(next.customProviders ?? []);
                }
                // Notify the desktop that the model catalog may have changed
                // (new apiKeys unlocked a provider, customProviders added/removed
                // entries). Desktop re-pulls providers.list / session.listModels
                // to refresh the Model menu without a restart.
                if ("apiKeys" in globalPatch || "customProviders" in globalPatch) {
                    server.broadcastModelsChanged();
                }
                // Invalidate compaction caches across all workspaces: after
                // a user changes the threshold, the current session's next
                // `effectiveCompaction()` reads the new value immediately
                // (no TTL wait). Only when the patch itself contains
                // compaction — same merge-semantics reason as above.
                if ("compaction" in globalPatch) {
                    server.invalidateCompactionCaches();
                }
                // Hot-reload instructions config across all workspaces. The
                // context hook reads via a lazy thunk on every LLM call, so
                // no per-session invalidation is needed. Like compaction,
                // only fire when the patch itself contains the field — a
                // merge that happens to land on the key without the user
                // editing it would otherwise trigger a pointless re-resolve.
                if ("instructions" in globalPatch) {
                    server.refreshInstructions(next.instructions);
                }
                return { global: toView(next) };
            } catch (e) {
                throw new RpcHandlerError(
                    ErrorCodes.InvalidValue,
                    e instanceof Error ? e.message : "settings.write failed",
                );
            }
        },
        { schema: settingsWriteSchema },
    );
}
