/**
 * Extension contract types — the public surface an extension author
 * imports and the loader / registry speak.
 *
 * Reuse from existing modules — do not re-define:
 *   - AgentTool (from @earendil-works/pi-agent-core) — replaced by TacoTool in this package
 *   - ContextEvent / ContextResult (from @earendil-works/pi-agent-core)
 *   - SystemPromptContributor (from ../prompts/buildSystemPrompt.ts)
 */

import type {
    AgentHarnessTool,
    ContextEvent,
    ContextResult,
    ExecutionToolContext,
    ToolCallEvent,
    ToolCallResult,
    ToolResultEvent,
    ToolResultPatch,
} from "@earendil-works/pi-agent-core";
import type { ExtensionPermission, ExtensionSource } from "@taco-ai/protocol";
import type { SystemPromptContributor } from "../prompts/buildSystemPrompt.ts";
import type { TagSpec } from "../tags/types.ts";
import type { TacoTool } from "../tools/index.ts";

// ExtensionPermission / ExtensionSource are owned by @taco-ai/protocol (single
// source of truth, consumed by the extensions.status RPC). Re-export them here
// so extension authors get the whole contract from this one module.
export type { ExtensionPermission, ExtensionSource } from "@taco-ai/protocol";
// Re-export the system-prompt contributor shape so the extension contract is
// complete from this module.
export type { SystemPromptContributor } from "../prompts/buildSystemPrompt.ts";

/** Supported contract versions. Loader rejects manifests declaring any other value. */
export type ExtensionApiVersion = "1";

export interface ExtensionManifest {
    readonly name: string;
    readonly version: string;
    readonly apiVersion: ExtensionApiVersion;
    readonly permissions: ReadonlyArray<ExtensionPermission>;
    /** Short description ("what it does"), from package.json taco.description, may be absent. */
    readonly description?: string;
    /** Usage guidance ("when to use it"), from package.json taco.whenToUse, may be absent. */
    readonly whenToUse?: string;
}

/**
 * Context hook handler. Same shape as AgentHarness.on("context", handler).
 *   - Return `undefined` (or void) → messages pass through unchanged
 *   - Return `{ messages }` → replace the messages array sent to the LLM
 */
export type ContextHook = (
    event: ContextEvent,
) => ContextResult | undefined | Promise<ContextResult | undefined>;

/**
 * Tool-call interceptor. Registered with `harness.on("tool_call", handler)`.
 * Return `undefined` → tool call proceeds normally.
 * Return `{ block: true, reason }` → the call is blocked; the harness
 * skips execution and records the tool result as-is.
 */
export type ToolCallHook = (
    event: ToolCallEvent,
) => ToolCallResult | undefined | Promise<ToolCallResult | undefined>;

/**
 * Tool-result interceptor. Registered with `harness.on("tool_result", handler)`.
 * Return `undefined` → result passes through unchanged.
 * Return a `ToolResultPatch` → fields merge onto the result:
 *   - `content` / `details` / `isError` overwrite the original
 *   - `terminate: true` → harness aborts the turn after this result
 */
export type ToolResultHook = (
    event: ToolResultEvent,
) => ToolResultPatch | undefined | Promise<ToolResultPatch | undefined>;

export interface ExtensionLogger {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
    debug(msg: string): void;
}

export interface ExtensionApi {
    readonly manifest: ExtensionManifest;
    readonly logger: ExtensionLogger;
    registerContextHook(hook: ContextHook): void;
    /** Intercept / block a tool invocation before it executes. */
    registerToolCallInterceptor(hook: ToolCallHook): void;
    /** Transform a tool result after execution; can also terminate the turn. */
    registerToolResultInterceptor(hook: ToolResultHook): void;
    registerTool(tool: AgentHarnessTool<ExecutionToolContext>): void;
    registerSystemPrompt(contributor: SystemPromptContributor): void;
    /** Register a custom tag — flows through the tag system's pin/drop/visibility
     *  pipeline. Requires the `tags` permission in the manifest. */
    registerTag(spec: TagSpec): void;
}

export type ExtensionModule = (api: ExtensionApi) => void | Promise<void>;

/**
 * A per-workspace contribution produced by an activator.
 * Any field may be omitted; missing means "no contribution this workspace".
 *
 * `source` defaults to `"builtin"` when the contribution comes from a builtin
 * activator. External activators (when exposed in the future) must set it to
 * `"external"` so the set can preserve hook-ordering invariants
 * (builtins run before external).
 */
export interface WorkspaceContribution {
    contextHooks?: ContextHook[];
    toolCallHooks?: ToolCallHook[];
    toolResultHooks?: ToolResultHook[];
    tools?: Array<{ name: string; tool: TacoTool }>;
    systemPrompt?: SystemPromptContributor;
    source?: ExtensionSource;
}

/**
 * Callback registered at process startup, invoked once per workspace when
 * `activateExtensions` runs. May perform async I/O and decide conditionally
 * based on `ctx.cwd`.
 */
export type WorkspaceActivator = (ctx: {
    readonly cwd: string;
}) => WorkspaceContribution | undefined | Promise<WorkspaceContribution | undefined>;
