/** Minimal fake of the pi 0.85 harness+lane tool surface for unit tests. */

import type { AgentHarnessTool, ExecutionToolContext } from "../../src/runtime/pi/types.ts";
import type { ToolCollection } from "../../src/runtime/sessionToolController.ts";

/**
 * In pi 0.85 tool definitions live on the harness while the active set lives on
 * the lane, so `setTools` and `setActiveToolNames` are separate calls. The
 * controller always writes definitions before widening the active set;
 * `setToolsCalls` records the pair so tests can assert on the combination the
 * way they did when it was one call.
 */
export class FakeToolCollection implements ToolCollection {
    tools = new Map<string, AgentHarnessTool<ExecutionToolContext>>();
    active = new Set<string>();
    setToolsCalls: Array<{ tools: string[]; active: string[] }> = [];

    constructor(initial: AgentHarnessTool<ExecutionToolContext>[]) {
        for (const t of initial) {
            this.tools.set(t.name, t);
            this.active.add(t.name);
        }
    }

    async getTools(): Promise<AgentHarnessTool<ExecutionToolContext>[]> {
        return [...this.tools.values()];
    }

    async getActiveToolNames(): Promise<string[]> {
        return [...this.active];
    }

    async setTools(tools: readonly AgentHarnessTool<ExecutionToolContext>[]): Promise<void> {
        this.tools = new Map(tools.map((t) => [t.name, t]));
        // Definitions land before the active set widens, so record the tool
        // list against the active set as it stands right now; the following
        // setActiveToolNames call rewrites the entry.
        this.setToolsCalls.push({
            tools: tools.map((t) => t.name),
            active: [...this.active],
        });
    }

    async setActiveToolNames(names: readonly string[]): Promise<void> {
        this.active = new Set(names);
        const last = this.setToolsCalls[this.setToolsCalls.length - 1];
        if (last) last.active = [...this.active];
    }
}
