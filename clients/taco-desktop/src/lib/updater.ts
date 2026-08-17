/**
 * updater.ts — thin wrapper over `@tauri-apps/plugin-updater` that
 * gives `UpdateDialog.tsx` a typed state machine + progress callback.
 *
 * Why the wrapper exists at all (rather than calling the plugin inline):
 *   1. Centralizes the plugin/process imports so the component is just
 *      "render this state". Tests can stub the wrapper without dragging
 *      in the plugin's full surface.
 *   2. Normalizes the `downloadAndInstall` callback (the plugin uses
 *      a discriminated union) into a single `progress: 0..1` number
 *      the progress bar can render directly, including the snap to 100%
 *      on the `Finished` event so the bar doesn't stall one frame
 *      short.
 *
 * No client-side "is configured?" guard — once the pubkey lands in
 * tauri.conf.json and the manifest exists, `downloadAndInstall` either
 * succeeds or throws a real error from the plugin. We surface that
 * error verbatim so the user sees "signature verification failed" or
 * "404 Not Found" instead of a hand-rolled "infrastructure is being
 * prepared" stub.
 */

import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

export type UpdateState = "idle" | "checking" | "available" | "downloading" | "ready" | "error";

export interface UpdateStatus {
    state: UpdateState;
    version?: string;
    /** 0..1; only meaningful while state === "downloading". */
    progress?: number;
    error?: string;
}

/** Upper bound on how long checkForUpdate waits for the manifest
 *  fetch. The plugin's Builder has no .timeout() method, so a hung
 *  HTTP request otherwise pins the Updates tab in "Checking…"
 *  indefinitely on networks that block GitHub. 30s matches the
 *  reqwest default for the CLI; tuned conservatively so a slow
 *  redirect (releases/latest → asset URL) still completes. */
const CHECK_TIMEOUT_MS = 30_000;

export async function checkForUpdate(): Promise<UpdateStatus> {
    try {
        const update = await Promise.race([
            check(),
            new Promise<never>((_, reject) => {
                setTimeout(
                    () =>
                        reject(
                            new Error(`Update check timed out after ${CHECK_TIMEOUT_MS / 1000}s`),
                        ),
                    CHECK_TIMEOUT_MS,
                );
            }),
        ]);
        if (!update) return { state: "idle" };
        return { state: "available", version: update.version };
    } catch (err) {
        return {
            state: "error",
            error: err instanceof Error ? err.message : String(err),
        };
    }
}

/** Discriminated union of the plugin's download callback events.
 *  `downloadAndInstall` passes { event, data } shaped objects; we
 *  collapse them into a closed set so the tracker can pattern-match. */
type DownloadFold =
    | { kind: "started"; total: number }
    | { kind: "progress"; chunk: number }
    | { kind: "finished" }
    | { kind: "unknown" };

function foldDownloadEvent(event: unknown): DownloadFold {
    if (!event || typeof event !== "object") return { kind: "unknown" };
    const e = event as {
        event?: string;
        data?: { contentLength?: number; chunkLength?: number };
    };
    if (e.event === "Started") {
        return { kind: "started", total: e.data?.contentLength ?? 0 };
    }
    if (e.event === "Progress") {
        // The plugin only tells us the chunk size in the Progress event,
        // not the running total; we accumulate across events.
        return { kind: "progress", chunk: e.data?.chunkLength ?? 0 };
    }
    if (e.event === "Finished") {
        return { kind: "finished" };
    }
    return { kind: "unknown" };
}

/** Bookkeeping for incremental progress accounting. `Started` gives us
 *  the total; `Progress` events report chunk sizes; `Finished` snaps
 *  the bar to 100% so the last frame before `downloadAndInstall`
 *  resolves doesn't sit at e.g. 97%. */
function makeProgressTracker() {
    let downloaded = 0;
    let total = 0;
    return (event: unknown): number => {
        const folded = foldDownloadEvent(event);
        switch (folded.kind) {
            case "started":
                total = folded.total;
                return 0;
            case "progress":
                downloaded += folded.chunk;
                return total > 0 ? Math.min(1, downloaded / total) : 0;
            case "finished":
                return 1;
            default:
                return total > 0 ? Math.min(1, downloaded / total) : 0;
        }
    };
}

export async function applyUpdate(onProgress: (progress: number) => void): Promise<UpdateStatus> {
    let update: Update;
    try {
        const found = await check();
        if (!found) return { state: "idle" };
        update = found;
    } catch (err) {
        return {
            state: "error",
            error: err instanceof Error ? err.message : String(err),
        };
    }
    const progress = makeProgressTracker();
    try {
        await update.downloadAndInstall((event: unknown) => {
            onProgress(progress(event));
        });
        return { state: "ready", version: update.version };
    } catch (err) {
        return {
            state: "error",
            error: err instanceof Error ? err.message : String(err),
        };
    }
}

/** Re-launch the desktop binary. Called only after a successful
 *  download+install so the running process is replaced by the freshly
 *  installed one. Wrapped to keep the @tauri-apps/plugin-process import
 *  in one file; the rest of the codebase can mock `applyUpdate` /
 *  checkForUpdate` instead. Re-throws so the dialog can surface
 *  elevation-cancel errors via the state machine. */
export async function relaunchDesktop(): Promise<void> {
    await relaunch();
}

/** Returns the version of the running binary, as embedded in
 *  tauri.conf.json. Used by the Updates tab to render "Current
 *  version" without hardcoding. Throws in dev (Tauri's app API
 *  isn't fully available outside the runtime); callers should
 *  treat that as "unknown" and skip the row. */
export async function getCurrentVersion(): Promise<string> {
    return getVersion();
}
