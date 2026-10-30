/**
 * The single write path for a session's tool state.
 *
 * Three callers change it — dynamic loading (`SessionToolController`), the
 * per-turn workspace refresh and the attach-time allowlist realignment — each
 * with its own add/remove rule. They share this queue so a plan is always
 * computed from the state the previous one committed: reading outside the
 * queue and only serialising the writes would still let a refresh overwrite a
 * tool `addTools` installed a moment earlier.
 */

import type { AgentHarnessTool, ExecutionToolContext } from "../pi/types.ts";

type Tool = AgentHarnessTool<ExecutionToolContext>;

/**
 * Minimal harness/lane surface — allows a fake for unit tests.
 *
 * pi splits tool state across two objects: the harness owns the tool
 * *definitions* (in memory only) while the lane owns which of them are
 * *active* (persisted in the lane configuration, one entry per write).
 */
export interface ToolCollection {
    getTools(): Promise<readonly Tool[]>;
    setTools(tools: readonly Tool[]): Promise<void>;
    /** Active tool NAMES — pi returns names, not tool objects. */
    getActiveToolNames(): Promise<readonly string[]>;
    setActiveToolNames(names: readonly string[]): Promise<void>;
}

export interface ToolState {
    readonly tools: readonly Tool[];
    readonly activeNames: readonly string[];
}

/** The target state; an omitted half is left as it is. */
export interface ToolStateChange {
    readonly tools?: readonly Tool[];
    readonly activeNames?: readonly string[];
}

export class SessionToolState {
    private pending = Promise.resolve();

    constructor(private readonly target: ToolCollection) {}

    /** Unqueued snapshot, for readers that do not write back. */
    async read(): Promise<ToolState> {
        return {
            tools: await this.target.getTools(),
            activeNames: await this.target.getActiveToolNames(),
        };
    }

    /**
     * Queue `plan` behind every earlier update, hand it the current state and
     * commit what it returns (undefined = no change). `committed` runs in the
     * same slot once the commit landed, so caller bookkeeping derived from it
     * is in place before the next plan reads. Resolves to whether anything was
     * written; a rejection reaches this caller only and the next update still
     * runs.
     */
    update(
        plan: (
            current: ToolState,
        ) => Promise<ToolStateChange | undefined> | ToolStateChange | undefined,
        committed?: () => void,
    ): Promise<boolean> {
        const run = this.pending.then(async () => {
            const current = await this.read();
            const change = await plan(current);
            const wrote = change ? await this.commit(current, change) : false;
            committed?.();
            return wrote;
        });
        this.pending = run.then(
            () => undefined,
            () => undefined,
        );
        return run;
    }

    /**
     * pi checks at generation time that every active name has a definition, so
     * a turn running concurrently must never see a name ahead of its tool or a
     * tool retired under an active name. Hence: narrow the allowlist, swap the
     * definitions, then widen it — skipping each step that changes nothing, so
     * the steady state writes no lane config entry at all.
     */
    private async commit(current: ToolState, change: ToolStateChange): Promise<boolean> {
        const tools = change.tools ?? current.tools;
        const active = change.activeNames ?? current.activeNames;
        const toolsChanged = !sameItems(current.tools, tools);
        const before = new Set(current.tools.map((t) => t.name));
        const after = new Set(tools.map((t) => t.name));
        // Only names gaining a definition in this commit wait for the swap. A
        // name defined on neither side passes through untouched: it may be a
        // tool whose load failed this time, and dropping it would lose it.
        const narrowed = active.filter((name) => before.has(name) || !after.has(name));

        let wrote = false;
        if (!sameItems(current.activeNames, narrowed)) {
            await this.target.setActiveToolNames(narrowed);
            wrote = true;
        }
        if (toolsChanged) {
            await this.target.setTools(tools);
            wrote = true;
        }
        if (!sameItems(narrowed, active)) {
            await this.target.setActiveToolNames(active);
            wrote = true;
        }
        return wrote;
    }
}

/** Order-sensitive, by identity: a rebuilt tool object counts as a change. */
function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
    return a.length === b.length && a.every((item, i) => item === b[i]);
}
