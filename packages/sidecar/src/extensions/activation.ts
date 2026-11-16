/**
 * activation — per-workspace extension activation.
 *
 * Merges process-level contributions (from `ExtensionRegistry`) with
 * per-workspace contributions into a frozen `WorkspaceExtensionSet`.
 *
 * ⚠ Import constraint: MUST NOT import from `../runtime/*` — would create an
 *   `extensions → runtime → extensions` cycle.
 */

import type { ExtensionWorkspaceStatus } from "@taco-ai/protocol";
import { createLogger } from "../lib/logger.ts";
import type {
    ContextHookBuckets,
    ExtensionRegistry,
    SessionActivatorEntry,
    ToolResultHookBuckets,
} from "./registry.ts";
import type {
    ContextHook,
    ExtensionDisposer,
    ExtensionSource,
    ExtensionToolCandidateWithSource,
    SessionActivatorContext,
    SessionContribution,
    SessionRunEndEvent,
    SessionRunEndHook,
    SystemPromptContributor,
    ToolCallHook,
    ToolResultHook,
    WorkspaceContribution,
} from "./types.ts";

import { WorkspaceExtensionDiagnostics } from "./workspaceDiagnostics.ts";

const log = createLogger("taco-ext");

interface OwnedDisposer {
    readonly name: string;
    readonly dispose: ExtensionDisposer;
}

// One budget per scope bounds asynchronous extension cleanup during detach/shutdown.
const CLEANUP_TIMEOUT_MS = 5000;

async function awaitCleanup(task: Promise<void>, deadline: number, label: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const remaining = deadline - Date.now();
        const completed = await Promise.race([
            task.then(() => true),
            remaining > 0
                ? new Promise<boolean>((resolve) => {
                      timer = setTimeout(() => resolve(false), remaining);
                  })
                : Promise.resolve(false),
        ]);
        if (!completed) log.warn(`${label} exceeded extension cleanup timeout`);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

async function disposeOwned(
    disposers: readonly OwnedDisposer[],
    deadline = Date.now() + CLEANUP_TIMEOUT_MS,
): Promise<void> {
    for (const entry of [...disposers].reverse()) {
        const task = Promise.resolve()
            .then(() => entry.dispose())
            .catch((error) => {
                log.warn(
                    `extension "${entry.name}" disposer failed: ${error instanceof Error ? error.message : String(error)}`,
                );
            });
        await awaitCleanup(task, deadline, `extension "${entry.name}" disposer`);
    }
}

export class SessionExtensionSet {
    private readonly disposers: OwnedDisposer[] = [];
    private readonly runEndHooks: Array<{
        name: string;
        hook: SessionRunEndHook;
        ctx: SessionActivatorContext;
    }> = [];
    private readonly pending = new Set<Promise<void>>();
    private readonly disposal: { promise?: Promise<void> } = {};
    private disposed = false;

    constructor(private readonly ctx: SessionActivatorContext) {}

    addContribution(name: string, contribution: SessionContribution, ctx = this.ctx): void {
        for (const hook of contribution.runEndHooks ?? [])
            this.runEndHooks.push({ name, hook, ctx });
        for (const dispose of contribution.disposers ?? []) this.disposers.push({ name, dispose });
    }

    listenerCount(): number {
        return this.runEndHooks.length;
    }

    notifyRunEnd(status: SessionRunEndEvent["status"]): void {
        if (this.disposed) return;
        for (const { name, hook, ctx } of this.runEndHooks) {
            const event: SessionRunEndEvent = { ...ctx, status };
            try {
                const result = hook(event);
                if (!result || typeof result.then !== "function") continue;
                const tracked = Promise.resolve(result)
                    .catch((error) => {
                        log.warn(
                            `extension "${name}" run-end listener failed: ${error instanceof Error ? error.message : String(error)}`,
                        );
                    })
                    .finally(() => this.pending.delete(tracked));
                this.pending.add(tracked);
            } catch (error) {
                log.warn(
                    `extension "${name}" run-end listener threw: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }
    }

    dispose(): Promise<void> {
        this.disposal.promise ??= this.disposeNow();
        return this.disposal.promise;
    }

    private async disposeNow(): Promise<void> {
        this.disposed = true;
        const deadline = Date.now() + CLEANUP_TIMEOUT_MS;
        await awaitCleanup(
            Promise.all([...this.pending]).then(() => {}),
            deadline,
            "run-end listeners",
        );
        await disposeOwned(this.disposers, deadline);
    }
}

/**
 * Contributions are frozen at workspace activation time. Lifecycle bookkeeping
 * remains mutable; the registry reference only records activation failures.
 */
export class WorkspaceExtensionSet {
    private readonly _toolsWithSource: NonNullable<WorkspaceContribution["tools"]> = [];
    private readonly _toolCandidates: ExtensionToolCandidateWithSource[] = [];
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
    private readonly _commandPermissionRules: string[] = [];
    private readonly _sessionActivators: SessionActivatorEntry[] = [];
    private readonly _disposers: OwnedDisposer[] = [];
    private readonly disposal: { promise?: Promise<void> } = {};

    private readonly diagnostics = new WorkspaceExtensionDiagnostics();

    constructor(private readonly registry?: ExtensionRegistry) {
        for (const entry of registry?.report.loaded ?? []) {
            this.diagnostics.add(entry.name, {
                contributions: { ...entry.contributions, workspaceActivators: 0 },
            });
        }
    }

    recordActivation(
        name: string,
        contribution?: WorkspaceContribution,
        failure?: string,
        reason?: string,
    ): void {
        this.diagnostics.record(name, contribution, failure, reason);
    }

    activationReport(): Promise<ExtensionWorkspaceStatus[]> {
        return this.diagnostics.report();
    }

    addContribution(
        source: ExtensionSource,
        c: WorkspaceContribution,
        extName = "unknown",
        config: Readonly<Record<string, unknown>> = Object.freeze({}),
    ): void {
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
        if (c.toolCandidates) {
            this._toolCandidates.push(...c.toolCandidates);
        }
        for (const activator of c.sessionActivators ?? []) {
            this._sessionActivators.push({ source, extName, activator, config });
        }
        for (const dispose of c.disposers ?? []) this._disposers.push({ name: extName, dispose });
        if (c.commandPermissionRules) {
            this._commandPermissionRules.push(...c.commandPermissionRules);
        }
        if (c.systemPrompt) {
            this._systemPromptContributors.push(c.systemPrompt);
        }
    }

    addSessionActivator(entry: SessionActivatorEntry): void {
        this._sessionActivators.push(entry);
    }

    async activateSession(ctx: SessionActivatorContext): Promise<SessionExtensionSet> {
        const set = new SessionExtensionSet(ctx);
        for (const entry of this._sessionActivators) {
            try {
                const extensionCtx = { ...ctx, config: entry.config ?? Object.freeze({}) };
                const contribution = await entry.activator(extensionCtx);
                if (contribution) set.addContribution(entry.extName, contribution, extensionCtx);
            } catch (error) {
                this.registry?.recordFailed(
                    entry.extName,
                    `session activation: ${error instanceof Error ? error.message : String(error)}`,
                    "session",
                );
                log.warn(
                    `session activator "${entry.extName}" failed: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }
        return set;
    }

    dispose(): Promise<void> {
        this.disposal.promise ??= disposeOwned(this._disposers);
        return this.disposal.promise;
    }

    toolsWithSource(): NonNullable<WorkspaceContribution["tools"]> {
        return [...this._toolsWithSource];
    }

    toolCandidates(): ExtensionToolCandidateWithSource[] {
        return [...this._toolCandidates];
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

    /** Extension-contributed shell allow-rules, deduped. Merged after the
     *  user's `commandPermissions.allow` by the workspace's permission thunk. */
    commandPermissionRules(): string[] {
        return Array.from(new Set(this._commandPermissionRules));
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
    const set = new WorkspaceExtensionSet(registry);

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
                ) {
                    set.recordActivation(entry.extName, undefined, undefined, "imWorkspace");
                    continue;
                }
                const result = await entry.activator({
                    ...ctx,
                    config: entry.config ?? Object.freeze({}),
                });
                set.recordActivation(entry.extName, result);
                if (result !== undefined) {
                    set.addContribution(entry.source, result, entry.extName, entry.config);
                }
            } catch (e) {
                set.recordActivation(entry.extName, undefined, (e as Error).message);
                registry.recordFailed(
                    entry.extName,
                    `workspace activation: ${(e as Error).message}`,
                    "workspace",
                );
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
        const candidates = registry.toolCandidates();
        if (candidates.length > 0) {
            set.addContribution("external", { toolCandidates: candidates });
        }
        for (const entry of registry.sessionActivators()) set.addSessionActivator(entry);
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
