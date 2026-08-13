/**
 * Sidecar client — thin React wrapper.
 * Rust owns **one** shared sidecar process; React does not spawn it directly — calls Tauri invoke,
 * listens to Tauri events. Rust is a pure byte pipe; it does not parse protocol frames:
 *  - `sidecar-event` payload `{ line }` — one NDJSON line from stdout; the workspace /
 *    session inside the frame is dispatched by the frontend
 *  - `sidecar-exited` payload `{ code, reason }` — process-level event, not tied to any workspace
 */

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type UnlistenFn } from "@tauri-apps/api/event";

export interface SidecarFrame {
    line: string;
}

export interface SidecarExit {
    code?: number;
    reason?: string;
}

/** Client-only spawn preferences (spawn-time decisions, not interpreted by the sidecar runtime).
 *  - debugMode: enables TACO_DEBUG_LLM_PAYLOAD=1 in the sidecar (LLM Dump panel reads this from memory; safe by default).
 *  - llmDumpToFile: on top of debugMode, additionally writes [taco:llm] lines to $TACO_HOME/logs/llm-dump.log.
 *    Writes plaintext conversation to disk; defaults to false; changing requires restartSidecar. */
export interface SidecarSpawnOptions {
    debugMode?: boolean;
    llmDumpToFile?: boolean;
}

/**
 * Client abstraction.
 */
export interface SidecarClient {
    /** Returns the first stdout line after spawning (null if already running). See the Rust
     * comment on `workspace_ensure` for rationale — callers use this to recover any
     * handshake frame they may have missed. */
    ensureWorkspace(cwd: string, options?: SidecarSpawnOptions): Promise<string | null>;
    send(cwd: string, frame: object): Promise<void>;
    disposeAll(): Promise<void>;
    onPush(handler: (frame: SidecarFrame) => void): Promise<UnlistenFn>;
    onExit(handler: (exit: SidecarExit) => void): Promise<UnlistenFn>;
}

export function createSidecarClient(deps: {
    invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
    listen: typeof tauriListen;
}): SidecarClient {
    const fire = (cmd: string, args?: Record<string, unknown>): Promise<void> =>
        deps.invoke(cmd, args).then(() => undefined);
    const send = (cwd: string, frame: object): Promise<void> =>
        fire("workspace_send", { cwd, line: JSON.stringify(frame) });

    return {
        ensureWorkspace: async (cwd, options) => {
            // Unlike the other commands this one has a return value, so it can't
            // go through `fire` (which discards it).
            const line = await deps.invoke("workspace_ensure", {
                cwd,
                debugMode: options?.debugMode ?? false,
                llmDumpToFile: options?.llmDumpToFile ?? false,
            });
            return typeof line === "string" ? line : null;
        },
        send,
        disposeAll: () => fire("workspace_dispose_all", {}),
        onPush: async (handler) =>
            deps.listen<SidecarFrame>("sidecar-event", (event) => {
                handler(event.payload);
            }),
        onExit: async (handler) =>
            deps.listen<SidecarExit>("sidecar-exited", (event) => {
                handler(event.payload);
            }),
    };
}

let _default: SidecarClient | null = null;

export function defaultSidecarClient(): SidecarClient {
    if (!_default) {
        _default = createSidecarClient({
            invoke: (cmd, args) => tauriInvoke(cmd, args),
            listen: tauriListen,
        });
    }
    return _default;
}
