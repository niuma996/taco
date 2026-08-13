/**
 * SessionToolController — per-session dynamic-tool loading state and orchestration.
 *
 * Responsibilities (one controller per AttachedSession):
 *   - tracks loaded dynamic tool names for this session;
 *   - lazily loads candidates from the registry and merges them into the harness
 *     (preserving the existing active set, so user-disabled tools stay disabled);
 *   - persists the full active-name list to the transcript via setTools
 *     (writes active_tools_change entries), enabling recovery after
 *     detach/reattach, sidecar restart, or compaction;
 *   - provides the toolContext getter so AddTools.execute (5th param) receives
 *     the current controller.
 *
 * Concurrency: addTools is serialised through a pending promise chain so two
 * concurrent calls never merge on a stale harness snapshot.
 */

import type {
    AgentHarnessTool,
    ExecutionToolContext,
    Session,
} from "@earendil-works/pi-agent-core";

/** Minimal harness surface required by the controller — allows a fake for unit tests. */
export interface ToolCollection {
    getTools(): readonly AgentHarnessTool<ExecutionToolContext>[];
    setTools(
        tools: readonly AgentHarnessTool<ExecutionToolContext>[],
        activeToolNames?: readonly string[],
    ): Promise<void>;
    getActiveTools(): readonly AgentHarnessTool<ExecutionToolContext>[];
}

import type { TacoTool } from "../tools/index.ts";
import type { DeferredToolRegistry } from "./deferredToolRegistry.ts";

export interface AddToolsResult {
    /** Tool names successfully added in this batch. */
    added: string[];
    /** Tool names already active — idempotent skip. */
    skipped: string[];
    /** Names not present in the candidate registry. */
    unknown: string[];
    /** Candidates that failed to load and the reason. */
    failed: Array<{ name: string; error: string }>;
}

/** Minimal interface exposed to AddTools. */
export interface SessionToolController {
    /** Called by AttachedSession.create after the harness is constructed. */
    bindHarness(harness: ToolCollection): void;
    /**
     * Restores tools persisted in the session branch and returns the loaded tool objects.
     * MUST be called before the harness is constructed; the caller merges the returned
     * tools into the initial tools array — this avoids a spurious active_tools_change
     * write on attach.
     */
    restoreTools(session: Session): Promise<TacoTool[]>;
    /** Merges tools into the harness and persists the active-name list. */
    addTools(names: readonly string[]): Promise<AddToolsResult>;
    /** Names of dynamic tools loaded in this session (excludes built-ins). */
    loadedToolNames(): readonly string[];
    /** Current active tool names (built-ins + dynamic, mirrors harness state). */
    activeToolNames(): readonly string[];
    /** The registry for this session — used by AddTools.description to list candidates. */
    readonly registry: DeferredToolRegistry;
}

export class DefaultSessionToolController implements SessionToolController {
    readonly registry: DeferredToolRegistry;
    private harness?: ToolCollection;
    /** Loaded dynamic tool names, in stable insertion order. */
    private loadedNames: string[] = [];
    private pending = Promise.resolve();

    constructor(registry: DeferredToolRegistry) {
        this.registry = registry;
    }

    bindHarness(harness: ToolCollection): void {
        this.harness = harness;
    }

    loadedToolNames(): readonly string[] {
        return [...this.loadedNames];
    }

    activeToolNames(): readonly string[] {
        if (!this.harness) return [];
        return this.harness.getActiveTools().map((t) => t.name);
    }

    /**
     * Restores tools persisted in the session branch transcript. Candidates
     * still in the registry are restored; vanished or failed candidates are
     * skipped silently (the name was already persisted so re-attaching the
     * same session will attempt to restore it again — this is intentional).
     *
     * Always-loaded candidates are owned by AttachedSession.create's always
     * block; restoreTools must skip them or the constructor would see two
     * tool objects with the same name (AgentHarness.validateUniqueNames
     * throws "Duplicate tool name(s)"). Persisted activeToolNames includes
     * always tools because setTools records the full active set, so the
     * filter has to happen here rather than relying on the harness to drop them.
     */
    async restoreTools(session: Session): Promise<TacoTool[]> {
        const context = await session.buildContext();
        const persistedNames = context.activeToolNames ?? [];
        const alwaysNames = new Set(this.registry.listAlways().map((c) => c.name));
        const loaded = new Map<string, TacoTool>();
        for (const name of persistedNames) {
            if (alwaysNames.has(name)) {
                // The always block in AttachedSession.create is the single
                // owner; loading it here would double-load and trip the harness
                // name-uniqueness check.
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

    addTools(names: readonly string[]): Promise<AddToolsResult> {
        // Serialise: each call chains onto the previous, guaranteeing the latest snapshot.
        const run = this.pending.then(() => this.load(names));
        // Errors must not break the chain so subsequent calls still execute.
        this.pending = run.then(
            () => undefined,
            () => undefined,
        );
        return run;
    }

    private async load(names: readonly string[]): Promise<AddToolsResult> {
        const harness = this.harness;
        if (!harness) {
            throw new Error("session tool controller not bound to a harness yet");
        }
        const currentTools = new Map(harness.getTools().map((t) => [t.name, t]));
        const activeNames = new Set(harness.getActiveTools().map((t) => t.name));

        const added: string[] = [];
        const skipped: string[] = [];
        const unknown: string[] = [];
        const failed: Array<{ name: string; error: string }> = [];
        const toLoad: TacoTool[] = [];

        for (const name of names) {
            if (activeNames.has(name) || currentTools.has(name)) {
                // Already active or defined: idempotent skip.
                skipped.push(name);
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
            toLoad.push(tool);
        }

        // Atomic commit: if any factory failed, leave harness and loadedNames unchanged.
        if (failed.length > 0) return { added: [], skipped, unknown, failed };

        if (added.length > 0) {
            await harness.setTools([...currentTools.values()], [...activeNames, ...added]);
            for (const name of added) {
                if (!this.loadedNames.includes(name)) this.loadedNames.push(name);
            }
        }

        return { added, skipped, unknown, failed };
    }
}
