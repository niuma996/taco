/**
 * SessionToolController — per-session dynamic-tool loading state and orchestration.
 *
 * Responsibilities (one controller per AttachedSession):
 *   - tracks loaded dynamic tool names for this session;
 *   - lazily loads candidates from the registry and merges them into the harness
 *     (preserving the existing active set, so user-disabled tools stay disabled);
 *   - persists the full active-name list in the lane configuration (via
 *     setActiveTools), enabling recovery after detach/reattach, sidecar
 *     restart, or compaction;
 *   - provides the toolContext getter so AddTools.execute (5th param) receives
 *     the current controller.
 *
 * Concurrency: every merge runs inside `SessionToolState.update`, the queue
 * the per-turn refresh also writes through, so no merge reads a stale snapshot.
 */

import { isFsToolDenied } from "../../tools/fileAccess.ts";
import type { TacoTool } from "../../tools/index.ts";
import type { DeferredToolRegistry } from "./deferredToolRegistry.ts";
import type { SessionToolState, ToolState, ToolStateChange } from "./sessionToolState.ts";

export interface AddToolsResult {
    /** Tool names successfully added in this batch. */
    added: string[];
    /** Tool names already active — idempotent skip. */
    skipped: string[];
    /** Names not present in the candidate registry. */
    unknown: string[];
    /** Candidates that failed to load and the reason. */
    failed: Array<{ name: string; error: string }>;
    /** Names the session's policy refuses to load, with the reason. */
    blocked: Array<{ name: string; reason: string }>;
}

export interface SessionToolControllerOptions {
    /**
     * True when the session's policy denies filesystem tools. Re-resolved
     * on each use (a thunk, not a value) so a policy edit between turns
     * reaches the load-time gate on the next call. Reads the same
     * tool-context signal the execution-time refusals (`refuseInIm`) see,
     * so the load-time and call-time verdicts cannot drift apart.
     */
    readonly fsToolsDenied: () => boolean | Promise<boolean>;
}

/** Minimal interface exposed to AddTools. */
export interface SessionToolController {
    /** Called by AttachedSession.create after the harness is constructed. */
    bindHarness(toolState: SessionToolState): void;
    /**
     * Restores tools recorded in the lane's persisted active-tool list and
     * returns the loaded tool objects. MUST be called before the harness is
     * constructed; the caller merges the returned tools into the initial tools
     * array, which avoids a redundant config write on attach.
     */
    restoreTools(activeToolNames: readonly string[]): Promise<TacoTool[]>;
    /** Merges tools into the harness and persists the active-name list. */
    addTools(names: readonly string[]): Promise<AddToolsResult>;
    /** Names of dynamic tools loaded in this session (excludes built-ins). */
    loadedToolNames(): readonly string[];
    /** Current active tool names (built-ins + dynamic, mirrors lane state). */
    activeToolNames(): Promise<readonly string[]>;
    /**
     * Names of every tool currently *defined* (the collection half, as opposed
     * to `activeToolNames`'s lane half). The two can disagree: a name on the
     * lane allowlist with no definition behind it makes pi fail the generation.
     */
    installedToolNames(): Promise<readonly string[]>;
    /** The registry for this session — used by AddTools.description to list candidates. */
    readonly registry: DeferredToolRegistry;
}

const FS_DENY_REASON =
    "the session's policy denies file tools, so it is not available in this session";

export class DefaultSessionToolController implements SessionToolController {
    readonly registry: DeferredToolRegistry;
    private toolState?: SessionToolState;
    /** Loaded dynamic tool names, in stable insertion order. */
    private loadedNames: string[] = [];
    private readonly fsToolsDenied: () => boolean | Promise<boolean>;

    constructor(registry: DeferredToolRegistry, options?: SessionToolControllerOptions) {
        this.registry = registry;
        // Default deny-nothing: direct constructions in tests and any
        // future call site without a policy hook keep today's behaviour.
        this.fsToolsDenied = options?.fsToolsDenied ?? (() => false);
    }

    bindHarness(toolState: SessionToolState): void {
        this.toolState = toolState;
    }

    loadedToolNames(): readonly string[] {
        return [...this.loadedNames];
    }

    async activeToolNames(): Promise<readonly string[]> {
        if (!this.toolState) return [];
        return [...(await this.toolState.read()).activeNames];
    }

    async installedToolNames(): Promise<readonly string[]> {
        if (!this.toolState) return [];
        return (await this.toolState.read()).tools.map((tool) => tool.name);
    }

    /**
     * Restores tools persisted in the session branch transcript. Candidates
     * still in the registry are restored; vanished or failed candidates are
     * skipped silently (the name was already persisted so re-attaching the
     * same session will attempt to restore it again — this is intentional).
     * A file tool the session's policy denies is skipped too: loading it
     * would install a tool whose every call refuses, so the attach-time
     * prune (`pruneDeniedFsTools` in toolsetRefresh.ts) also drops its name —
     * a name on the allowlist with no definition makes pi fail the
     * generation (`configured_tools_unavailable`).
     *
     * Always-loaded candidates are owned by AttachedSession.create's always
     * block; restoreTools must skip them or the constructor would see two
     * tool objects with the same name (AgentHarness.validateUniqueNames
     * throws "Duplicate tool name(s)"). Persisted activeToolNames includes
     * always tools because setTools records the full active set, so the
     * filter has to happen here rather than relying on the harness to drop them.
     */
    async restoreTools(activeToolNames: readonly string[]): Promise<TacoTool[]> {
        const persistedNames = activeToolNames;
        const alwaysNames = new Set(this.registry.listAlways().map((c) => c.name));
        // Resolved once per restore: the verdict must hold for the whole
        // batch, and the thunk stays per-use for the addTools path.
        const fsDenied = await this.fsToolsDenied();
        const loaded = new Map<string, TacoTool>();
        for (const name of persistedNames) {
            if (alwaysNames.has(name)) {
                // The always block in AttachedSession.create is the single
                // owner; loading it here would double-load and trip the harness
                // name-uniqueness check.
                continue;
            }
            if (isFsToolDenied(name, fsDenied)) {
                // Policy, not a load failure: the name is not loaded, and the
                // attach-time prune removes it from the allowlist.
                continue;
            }
            try {
                const tool = await this.registry.load(name);
                if (tool) loaded.set(name, tool);
            } catch {
                // Candidate vanished or load failed — skip silently; the persisted
                // name remains so re-attaching the same session retries on next startup.
            }
        }
        this.loadedNames = [...loaded.keys()];
        return [...loaded.values()];
    }

    async addTools(names: readonly string[]): Promise<AddToolsResult> {
        const toolState = this.toolState;
        if (!toolState) {
            throw new Error("session tool controller not bound to a harness yet");
        }
        let result: AddToolsResult = { added: [], skipped: [], unknown: [], failed: [], blocked: [] };
        await toolState.update(async (current) => {
            const plan = await this.plan(names, current);
            result = plan.result;
            return plan.change;
        });
        for (const name of result.added) {
            if (!this.loadedNames.includes(name)) this.loadedNames.push(name);
        }
        return result;
    }

    private async plan(
        names: readonly string[],
        current: ToolState,
    ): Promise<{ result: AddToolsResult; change?: ToolStateChange }> {
        const currentTools = new Map(current.tools.map((t) => [t.name, t]));
        const activeNames = new Set(current.activeNames);

        const added: string[] = [];
        const skipped: string[] = [];
        const unknown: string[] = [];
        const failed: Array<{ name: string; error: string }> = [];
        const blocked: Array<{ name: string; reason: string }> = [];
        const fsDenied = await this.fsToolsDenied();

        for (const name of names) {
            if (activeNames.has(name) || currentTools.has(name)) {
                // Already active or defined: idempotent skip.
                skipped.push(name);
                continue;
            }
            if (isFsToolDenied(name, fsDenied)) {
                // Policy answer, not a load failure: report it and change nothing.
                blocked.push({ name, reason: FS_DENY_REASON });
                continue;
            }
            let tool: TacoTool | undefined;
            try {
                tool = await this.registry.load(name);
            } catch (error) {
                failed.push({
                    name,
                    error: error instanceof Error ? error.message : String(error),
                });
                continue;
            }
            if (!tool) {
                unknown.push(name);
                continue;
            }
            // Register in the staging map immediately so repeated names in the same
            // request are caught as skipped, not as a second load attempt.
            currentTools.set(name, tool);
            added.push(name);
        }

        // Atomic commit: if any factory failed, leave the tool state unchanged.
        if (failed.length > 0) {
            return { result: { added: [], skipped, unknown, failed, blocked } };
        }

        const result = { added, skipped, unknown, failed, blocked };
        if (added.length === 0) return { result };
        return {
            result,
            change: {
                tools: [...currentTools.values()],
                activeNames: [...activeNames, ...added],
            },
        };
    }
}
