/**
 * activation — per-workspace extension activation.
 *
 * Merges process-level contributions (from `ExtensionRegistry`) with
 * per-workspace contributions into a frozen `WorkspaceExtensionSet`.
 *
 * ⚠ Import constraint: MUST NOT import from `../runtime/*` — would create an
 *   `extensions → runtime → extensions` cycle.
 */

import { createLogger } from "../lib/logger.ts";
import type { TacoTool } from "../tools/index.ts";
import type { ContextHookBuckets, ExtensionRegistry, ToolResultHookBuckets } from "./registry.ts";
import type {
    ContextHook,
    ExtensionSource,
    SystemPromptContributor,
    ToolCallHook,
    ToolResultHook,
    WorkspaceContribution,
} from "./types.ts";

const log = createLogger("taco-ext");

/**
 * Frozen snapshot of all contributions active in a single workspace.
 * Produced once by `activateExtensions` and held by `WorkspaceRuntime` for the
 * lifetime of that runtime instance.  This object is immutable: it captures the
 * contributions that existed at activation time and never re-queries the
 * `ExtensionRegistry`.
 */
export class WorkspaceExtensionSet {
    private readonly _toolsWithSource: Array<{ name: string; tool: TacoTool }> = [];
    private readonly _systemPromptContributors: SystemPromptContributor[] = [];
    private readonly _contextHooks: ContextHookBuckets = {
        builtins: [],
        external: [],
    };
    private readonly _toolCallHooks: ToolCallHook[] = [];
    private readonly _toolResultHooks: ToolResultHookBuckets = {
        builtins: [],
        external: [],
    };

    addContribution(source: ExtensionSource, c: WorkspaceContribution): void {
        const bucket = source === "builtin" ? "builtins" : "external";
        if (c.contextHooks) {
            this._contextHooks[bucket].push(...c.contextHooks);
        }
        if (c.toolCallHooks) {
            this._toolCallHooks.push(...c.toolCallHooks);
        }
        if (c.toolResultHooks) {
            this._toolResultHooks[bucket].push(...c.toolResultHooks);
        }
        if (c.tools) {
            for (const t of c.tools) this._toolsWithSource.push(t);
        }
        if (c.systemPrompt) {
            this._systemPromptContributors.push(c.systemPrompt);
        }
    }

    toolsWithSource(): Array<{ name: string; tool: TacoTool }> {
        return [...this._toolsWithSource];
    }

    systemPromptContributors(): SystemPromptContributor[] {
        return [...this._systemPromptContributors];
    }

    contextHooks(): { builtins: ContextHook[]; external: ContextHook[] } {
        return {
            builtins: [...this._contextHooks.builtins],
            external: [...this._contextHooks.external],
        };
    }

    toolCallHooks(): ToolCallHook[] {
        return [...this._toolCallHooks];
    }

    toolResultHooks(): { builtins: ToolResultHook[]; external: ToolResultHook[] } {
        return {
            builtins: [...this._toolResultHooks.builtins],
            external: [...this._toolResultHooks.external],
        };
    }
}

/**
 * Invoke all workspace activators on `registry` and merge their contributions
 * into a frozen per-workspace `WorkspaceExtensionSet`.
 *
 * `systemPromptContributors()` order: builtin activator contributors first,
 * then process-level external contributors. Builtin `tool_result` hooks merge
 * into the `builtins` bucket so `SessionRegistry` only needs the
 * `WorkspaceExtensionSet` to wire all harness hooks.
 */
export async function activateExtensions(
    registry: ExtensionRegistry | undefined,
    ctx: { readonly cwd: string; readonly isIm?: boolean },
): Promise<Readonly<WorkspaceExtensionSet>> {
    const set = new WorkspaceExtensionSet();

    // 1. Workspace activators run FIRST so builtin contributors (e.g. git-context
    //    guidance) appear before process-level external contributors in the final
    //    systemPrompt.  Each activator may perform async I/O, decide based on
    //    ctx.cwd, and return undefined ("no contribution this workspace").
    if (registry) {
        for (const entry of registry.workspaceActivators()) {
            try {
                // These builtins probe workspace state that would leak fingerprint
                // information (project structure, file paths) onto IM/third-party
                // channels — short-circuit them before they probe.
                if (
                    ctx.isIm &&
                    (entry.extName === "@taco/builtin-git-context" ||
                        entry.extName === "@taco/builtin-project-manifest")
                )
                    continue;
                const result = await entry.activator(ctx);
                if (result !== undefined) {
                    set.addContribution(entry.source, result);
                }
            } catch (e) {
                log.error(`workspace activator "${entry.extName}" failed: ${(e as Error).message}`);
            }
        }
    }

    // 2. Process-level contributions from the registry: tools, systemPrompt,
    //    and hooks registered by extensions (via createExtensionApi) at
    //    process startup. Builtins register their process-level hooks the
    //    same way (source: "builtin") — see registerBuiltinExtensions.
    if (registry) {
        // systemPrompt: external contributors only — builtins use activators
        for (const c of registry.systemPromptContributors()) {
            set.addContribution("external", { systemPrompt: c });
        }
        // tools
        const tws = registry.toolsWithSource();
        if (tws.length > 0) {
            set.addContribution("external", { tools: tws });
        }
        // context hooks from process-level registry (builtins + external)
        for (const h of registry.contextHooks().builtins) {
            set.addContribution("builtin", { contextHooks: [h] });
        }
        for (const h of registry.contextHooks().external) {
            set.addContribution("external", { contextHooks: [h] });
        }
        // tool_call hooks (not bucketed by source on the registry today)
        const toolCallHooks = registry.toolCallHooks();
        if (toolCallHooks.length > 0) {
            set.addContribution("external", { toolCallHooks });
        }
        // tool_result hooks from process-level registry (builtins + external)
        for (const h of registry.toolResultHooks().builtins) {
            set.addContribution("builtin", { toolResultHooks: [h] });
        }
        for (const h of registry.toolResultHooks().external) {
            set.addContribution("external", { toolResultHooks: [h] });
        }
    }

    return Object.freeze(set);
}
