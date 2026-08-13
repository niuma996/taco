/**
 * Builtin contract — first-party extensions bypassing permission checks
 * (trust-bypass) and landing in the `builtins` bucket to run before external.
 * Only place a builtin declares how it registers itself.
 */

import type { TagSpec } from "../tags/types.ts";
import type { ExtensionSource, ToolResultHook, WorkspaceActivator } from "./types.ts";

/**
 * Minimal registry API surface exposed to builtin register functions.
 *
 * Deliberately excludes `recordLoaded`/`recordFailed` — the dispatcher
 * (`registerBuiltinExtensions`) owns that bookkeeping so a builtin can't be
 * double-recorded (once by itself, once by the dispatcher's try/catch).
 */
export interface BuiltinRegistryApi {
    addExtensionTag(extName: string, name: string, spec: TagSpec): boolean;
    addWorkspaceActivator(
        source: ExtensionSource,
        extName: string,
        activator: WorkspaceActivator,
    ): void;
    addToolResultInterceptor(source: ExtensionSource, hook: ToolResultHook): void;
}

/** Manifest for one built-in extension. */
export interface BuiltinManifest {
    /** Extension name, e.g. "@taco/builtin-output-redaction". */
    readonly name: string;
    /** Short description for the extensions.status report. */
    readonly description?: string;
    /** Usage guidance for the extensions.status report. */
    readonly whenToUse?: string;
    /**
     * Process-level registration callback.
     * Called once at startup if the builtin is not disabled.
     * Use this for hooks that do not depend on workspace cwd.
     */
    readonly register?: (registry: BuiltinRegistryApi) => void | Promise<void>;
    /**
     * Workspace-level activator factory.
     * Called once at startup to obtain an activator; the activator itself is
     * invoked once per workspace by `activateExtensions`.
     */
    readonly activator?: () => WorkspaceActivator | Promise<WorkspaceActivator>;
}
