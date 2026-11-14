/**
 * Pure-desktop client configuration stored in ~/.taco/desktop.json.
 * Sidecar does not read or write this file.
 */

import { invoke as tauriInvoke } from "@tauri-apps/api/core";

export interface OnboardingStatus {
    status: "completed" | "skipped";
    completedAt?: string;
    skippedAt?: string;
}

/**
 * Persisted workspace-list state, stored under `desktop.json.workspaces`.
 *
 * `opened` mirrors what used to live in `localStorage["taco.workspaces"]` —
 * the cwd list shown in the workspace dropdown. `active` mirrors
 * `localStorage["taco.activeCwd"]` and is one of `opened` (or, on first
 * boot before anything is opened, the default cwd).
 *
 * Kept out of localStorage: localStorage is per-WebView2 origin, so dev
 * (localhost:1420) and the packaged build (tauri.localhost) would each
 * remember a different list. desktop.json lives under $TACO_HOME and is
 * shared across both, which is what "I switched to nium-wiki yesterday in
 * dev and want it back in the packaged build" wants.
 */
export interface WorkspaceListState {
    opened: string[];
    active: string;
    /** Filesystem projects whose groups are explicitly expanded in the chat sidebar. */
    expanded?: string[];
    /** An explicitly emptied local workspace list must not be reseeded on startup. */
    emptyAllowed?: boolean;
}

export interface HiddenConversationBaseline {
    sessionId: string;
    lastUsedAt: number;
}

export interface DesktopConfig {
    /** IM routes hidden until their inbound activity advances past this baseline. */
    hiddenConversations?: Record<string, HiddenConversationBaseline>;
    onboarding?: OnboardingStatus;
    workspaces?: WorkspaceListState;
    /**
     * Sidecar spawn-time env mirror. Written by the Debug tab so the Rust
     * host can read it at spawn time (prewarm + reconnect + restart all
     * read this — localStorage alone is unreachable from the Tauri host).
     * `debugMode=true` injects `TACO_DEBUG_LLM_PAYLOAD=1` into the sidecar
     * process env, which gates the `[taco:llm]` stderr writer that feeds
     * the in-memory LLM Dump panel.
     */
    debugMode?: boolean;
    /**
     * Second opt-in that lets the Rust stderr reader also append the same
     * `[taco:llm]` lines to `$TACO_HOME/logs/llm-dump.log` (owner-only,
     * 10 MiB rotation × 3 retained). Separate from `debugMode` because
     * the disk write puts plaintext conversation in the user's home dir;
     * the Debug tab hides the row unless `debugMode` is on. No sidecar
     * env is required — the sidecar keeps writing to stderr either way.
     */
    llmDumpToFile?: boolean;
}

async function readRaw(): Promise<string> {
    return tauriInvoke<string>("desktop_config_read");
}

async function writeRaw(contents: string): Promise<void> {
    await tauriInvoke("desktop_config_write", { contents });
}

async function readConfig(): Promise<DesktopConfig> {
    const raw = await readRaw();
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" ? (parsed as DesktopConfig) : {};
}

export async function readDesktopConfig(options?: { strict?: boolean }): Promise<DesktopConfig> {
    try {
        return await readConfig();
    } catch (error) {
        if (options?.strict) throw error;
        console.error("[taco] failed to read desktop config", error);
    }
    return {};
}

let pendingWrite = Promise.resolve();

/** Serialize read/merge/write operations, including updates to nested config maps. */
export function writeDesktopConfig(
    patch: Partial<DesktopConfig> | ((current: DesktopConfig) => Partial<DesktopConfig>),
): Promise<void> {
    const write = pendingWrite.then(async () => {
        // A failed read must not turn a partial update into replacement of the whole config.
        const current = await readConfig();
        const next = { ...current, ...(typeof patch === "function" ? patch(current) : patch) };
        await writeRaw(JSON.stringify(next, null, 2));
    });
    pendingWrite = write.catch(() => {});
    return write;
}

export function isOnboardingRequired(config: DesktopConfig | null): boolean {
    if (!config) return true;
    return config.onboarding?.status !== "completed" && config.onboarding?.status !== "skipped";
}
