/**
 * Extension contract types — the public surface an extension author
 * imports and the loader / registry speak.
 *
 * The hook event types (ContextEvent / ToolCallEvent / ToolResultEvent
 * and their result counterparts) are owned here rather than re-exported
 * from pi: pi's Hooks class handler signature is `unknown => unknown`,
 * which would leak pi internals to extension authors. The contract here
 * is stable across pi versions; the wiring boundary in hookWiring.ts is
 * the only place that adapts when pi reshapes Hooks.
 *
 * Reuse from existing modules — do not re-define:
 *   - TacoTool (from this package) — replacement for AgentTool in extensions
 *   - AgentMessage / TextContent / ImageContent / Usage (from
 *     @earendil-works/pi-agent-core)
 *   - SystemPromptContributor (from ../prompts/buildSystemPrompt.ts)
 */

import type {
    AgentHarnessTool,
    AgentMessage,
    ExecutionToolContext,
} from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent, Usage } from "@earendil-works/pi-ai";
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
 * Context hook event — the messages about to be sent to the LLM. The hook
 * may return a `ContextResult` to replace the messages, or `undefined`
 * to pass them through unchanged. Single-purpose: no event-type discriminator.
 */
export interface ContextEvent {
    messages: AgentMessage[];
}

/**
 * Context hook return — when present, the `messages` field replaces the
 * outbound message list. When omitted, the messages pass through
 * unchanged. The `undefined` return value is equivalent to `{}`.
 */
export interface ContextResult {
    messages?: AgentMessage[];
}

/**
 * Tool-call interceptor event. Registered with
 * `api.registerToolCallInterceptor`. Return `{ block: true, reason }`
 * to prevent the call from executing; return `undefined` to let it
 * proceed normally.
 */
export interface ToolCallEvent {
    type: "tool_call";
    toolCallId: string;
    toolName: string;
    input: Record<string, unknown>;
}

/**
 * Result of a tool-call interceptor.
 */
export interface ToolCallResult {
    block?: boolean;
    reason?: string;
}

/**
 * Tool-result interceptor event. Registered with
 * `api.registerToolResultInterceptor`. Return a `ToolResultPatch` to
 * override the original fields; return `undefined` to leave the
 * result untouched.
 *
 * `terminate: true` aborts the turn after this result lands.
 */
export interface ToolResultEvent {
    type: "tool_result";
    toolCallId: string;
    toolName: string;
    input: Record<string, unknown>;
    content: Array<TextContent | ImageContent>;
    details: unknown;
    isError: boolean;
    usage?: Usage;
}

export interface ToolResultPatch {
    content?: Array<TextContent | ImageContent>;
    details?: unknown;
    isError?: boolean;
    usage?: Usage;
    terminate?: boolean;
}

/**
 * Context hook handler.
 *   - Return `undefined` (or void) → messages pass through unchanged
 *   - Return `{ messages }` → replace the messages array sent to the LLM
 */
export type ContextHook = (
    event: ContextEvent,
) => ContextResult | undefined | Promise<ContextResult | undefined>;

/**
 * Tool-call interceptor. Registered with
 * `api.registerToolCallInterceptor`. Return `undefined` → tool call
 * proceeds normally. Return `{ block: true, reason }` → the call is
 * blocked; the harness skips execution and records the tool result
 * as-is.
 */
export type ToolCallHook = (
    event: ToolCallEvent,
) => ToolCallResult | undefined | Promise<ToolCallResult | undefined>;

/**
 * Tool-result interceptor. Registered with
 * `api.registerToolResultInterceptor`. Return `undefined` → result
 * passes through unchanged. Return a `ToolResultPatch` → fields merge
 * onto the result; `terminate: true` aborts the turn.
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
