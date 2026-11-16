/**
 * Public surface of the sidecar extension system.
 *
 * External extension authors (and the in-tree wiring) should import
 * from this barrel, not the individual files. Adding exports here is
 * a deliberate API surface decision.
 */

export { activateExtensions, SessionExtensionSet, WorkspaceExtensionSet } from "./activation.ts";
export { createExtensionApi } from "./extensionApi.ts";
export type { LoadedConfig } from "./loader.ts";
export { loadExtensions } from "./loader.ts";
export type {
    ContextHookBuckets,
    LoadedEntry,
    RegistryReport,
    ToolResultHookBuckets,
} from "./registry.ts";
export { EXTERNAL_SOURCE, ExtensionRegistry } from "./registry.ts";
export type {
    ContextEvent,
    ContextHook,
    ContextResult,
    ExtensionApi,
    ExtensionApiVersion,
    ExtensionDisposer,
    ExtensionLogger,
    ExtensionManifest,
    ExtensionModule,
    ExtensionPermission,
    ExtensionSource,
    ExtensionToolCandidate,
    ExtensionToolCandidateWithSource,
    ExtensionToolRegistrationOptions,
    FileAccess,
    SessionActivator,
    SessionActivatorContext,
    SessionContribution,
    SessionRunEndEvent,
    SessionRunEndHook,
    TacoTool,
    TacoToolContext,
    ToolCallEvent,
    ToolCallHook,
    ToolCallResult,
    ToolResultEvent,
    ToolResultHook,
    ToolResultPatch,
    WorkspaceActivator,
    WorkspaceContribution,
} from "./types.ts";
