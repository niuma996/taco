/**
 * Desktop settings view — in-process singleton cache + a tiny subscriber.
 *
 * Design notes:
 *  - State has two parts: sidecar global config + client-side local settings.
 *    - `global`: from the sidecar's settings.get RPC; fields live in
 *      TacoGlobalConfigShape.
 *    - `client`: client-side local view; fields live in TacoClientSettingsShape
 *      (theme / debugMode / etc.).
 *  - Module-level cache + listener Set; UI components subscribe via
 *    `subscribeGlobalConfig`.
 *  - At startup, call `loadGlobalConfig(client)` once. After that,
 *    `writeClientSettings` auto-emits.
 *  - Sidecar config does NOT go through this module — callers should use
 *    `client.settingsWrite({ global: patch })` directly and either reload
 *    themselves or trust the sidecar's existing view. This module only
 *    manages local persistence of client-side fields.
 */

import type { TacoGlobalConfigView, ThinkingLevel } from "@taco-ai/protocol";
import type { TacoClientSettingsShape } from "./clientSettings.ts";
import { readClientSettings, saveClientSettings } from "./clientSettings.ts";
import type { TacoClient } from "./tacoClientTauri.ts";

/** thinkingLevel value domain (synced with sidecar config.ts) */
export const THINKING_LEVELS: readonly ThinkingLevel[] = [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
] as const;

/** Merged state — sidecar config (masked view) + client-side local settings */
export interface GlobalConfigState {
    /**
     * Sidecar's masked view — key fields are `{ configured, mask }`, not raw
     * strings. Reading `global.anthropicApiKey` returns
     * `{ configured: true, mask: "sk-ant-…AbCd" }` — never leaks plaintext.
     */
    global: TacoGlobalConfigView;
    /** Client-side local settings (theme / debugMode); unrelated to sidecar protocol */
    client: TacoClientSettingsShape;
    /** Whether sidecar config has been fetched; `false` → UI should avoid optimistic display from unread state */
    loaded: boolean;
}

const listeners = new Set<(s: GlobalConfigState) => void>();
let cache: GlobalConfigState = { global: {}, client: {}, loaded: false };

/** Read current cache synchronously (no RPC). */
export function getGlobalConfig(): GlobalConfigState {
    return cache;
}

/**
 * Subscribe to cache changes.
 *
 * Contract: `fn` is called only after `loadGlobalConfig` / `writeClientSettings`
 * complete — it does NOT immediately emit the current value on subscribe.
 * Consumers must pair `useState(() => getGlobalConfig())` (snapshot) with
 * `useEffect(() => subscribeGlobalConfig(setState), [])` (updates). Subscribing
 * without the snapshot leaves UI stuck on the initial `{ loaded: false }`.
 */
export function subscribeGlobalConfig(fn: (s: GlobalConfigState) => void): () => void {
    listeners.add(fn);
    return () => {
        listeners.delete(fn);
    };
}

function emit(): void {
    for (const fn of listeners) fn(cache);
}

/**
 * Replace local cache with the latest global view from `settings.write` RPC;
 * emits to all subscribers.
 *
 * Callers (useSaveConfigPatch "global" branch) must call this after writing to
 * sidecar — otherwise stale cache overwrites the UI on next render ("selected
 * but not applied").
 */
export function applyGlobalConfig(next: TacoGlobalConfigView): void {
    cache = { ...cache, global: next };
    emit();
}

/** Fetch sidecar view + read client local settings, merge into cache; emits to subscribers. */
export async function loadGlobalConfig(client: TacoClient): Promise<void> {
    // Sidecar is unaware of client fields (theme / debugMode); SettingsGetResult
    // only contains `global`. Client view is read from localStorage synchronously.
    const sidecarResult = await client.settingsGet();
    cache = {
        global: sidecarResult.global,
        client: readClientSettings(),
        loaded: true,
    };
    emit();
}

/**
 * Write client-side local settings (theme / debugMode) and replace cache; emits
 * to subscribers.
 *
 * Sidecar global config does NOT go through here — callers use
 * `client.settingsWrite({ global: patch })` directly.
 */
export async function writeClientSettings(patch: Partial<TacoClientSettingsShape>): Promise<void> {
    const next = saveClientSettings(patch);
    cache = { ...cache, client: next };
    emit();
}

/** Default level for new sessions — falls back to `"off"` when unset. */
export function defaultThinkingLevelForNewSession(g: TacoGlobalConfigView): ThinkingLevel {
    return g.thinkingLevel ?? "off";
}

/**
 * Default model for new sessions — returns `{ provider, id }` or `null`
 * (unset or backend not loaded yet).
 *
 * Symmetric with `defaultThinkingLevelForNewSession`, but model is a
 * provider+id pair. Returns null — caller falls back to `modelOptions[0]`.
 */
export function defaultModelForNewSession(
    g: TacoGlobalConfigView,
): { provider: string; id: string } | null {
    if (!g.defaultModel) return null;
    return {
        provider: g.defaultProvider ?? "",
        id: g.defaultModel,
    };
}
