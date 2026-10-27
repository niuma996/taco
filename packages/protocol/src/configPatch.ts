/**
 * The open-body request types for the global config.
 *
 * `settings.write` and `config.patch` carry a config patch whose field set
 * evolves with the config itself, so the validator stays loose and the shape
 * is declared here instead of being derived from a schema. The types live
 * apart from `config.ts` so the schema module can pin them without the two
 * importing each other.
 */

import type {
    CommandPermissionMode,
    CommandPermissionRule,
    TacoGlobalConfigShape,
} from "./config.js";
import type { SessionId, ToolCallId, WorkspaceId } from "./frames.js";
import type { ThinkingLevel } from "./messages.js";

/**
 * A `settings.write` patch: `TacoGlobalConfigShape` with `null` allowed on the
 * scalar fields `saveGlobalConfig` documents as clearable, as the explicit
 * "clear this field" value.
 *
 * `undefined` cannot express that over the wire — `JSON.stringify` drops an
 * undefined-valued key, so the field never reaches the sidecar and the stored
 * value survives a patch the client believed cleared it. `null` survives
 * serialization. Composite fields (nested config blocks, arrays, maps) keep
 * their existing merge semantics and are not part of this contract.
 */
export type GlobalConfigPatch = Partial<
    Omit<
        TacoGlobalConfigShape,
        | "defaultModel"
        | "defaultProvider"
        | "sessionsRoot"
        | "systemPrompt"
        | "thinkingLevel"
        | "anthropicApiKey"
        | "openaiApiKey"
    >
> & {
    /** Incremental permission changes applied atomically to the latest disk state. */
    commandPermissionsEdit?: {
        mode?: CommandPermissionMode;
        addAllow?: CommandPermissionRule[];
        removeAllow?: CommandPermissionRule[];
        addDeny?: CommandPermissionRule[];
        removeDeny?: CommandPermissionRule[];
    };
    defaultModel?: string | null;
    defaultProvider?: string | null;
    sessionsRoot?: string | null;
    systemPrompt?: string | null;
    thinkingLevel?: ThinkingLevel | null;
    anthropicApiKey?: string | null;
    openaiApiKey?: string | null;
};

/**
 * `settings.write` RPC params — write the sidecar global config to
 * `~/.taco/taco.json`.
 *
 * NOTE: this RPC does not accept client-side patches. Client-local
 * settings (theme / debugMode, ...) are written by the client itself to
 * localStorage / Tauri app config, not via the sidecar. `SettingsWriteParams.client`
 * is intentionally absent to prevent misuse of the RPC.
 */
export interface SettingsWriteParams {
    /** Sidecar config patch, merged back to `~/.taco/taco.json`. */
    global?: GlobalConfigPatch;
}

/**
 * `config.patch` RPC params — the model's path to the global config.
 *
 * Distinct from `settings.write`: the desktop writes the config itself and
 * needs no approval, while a change proposed by a model must be approved by
 * the user first. A config change can disable the very approvals that would
 * review it, so the write is gated here rather than by the caller.
 */
export interface ConfigPatchParams {
    /** Workspace the calling session belongs to. */
    workspace: WorkspaceId;
    /** Session the change was proposed from — the approval prompt routes to it. */
    sessionId: SessionId;
    /** Tool call that proposed the change, so the prompt lands on its card. */
    toolCallId: ToolCallId;
    /** The fields to change. Only these are touched. */
    patch: GlobalConfigPatch;
}
