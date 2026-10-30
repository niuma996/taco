/** Minimal fake of the pi 0.85 harness+lane tool surface for unit tests. */

import {
    SessionToolState,
    type ToolCollection,
} from "../../src/runtime/harness/sessionToolState.ts";
import type { AgentHarnessTool, ExecutionToolContext } from "../../src/runtime/pi/types.ts";

/**
 * Tool definitions live on the harness while the active set lives on the lane,
 * so `setTools` and `setActiveToolNames` are separate calls, as in pi.
 */
export class FakeToolCollection implements ToolCollection {
    tools = new Map<string, AgentHarnessTool<ExecutionToolContext>>();
    active = new Set<string>();

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
    }

    async setActiveToolNames(names: readonly string[]): Promise<void> {
        this.active = new Set(names);
    }
}

/** A `SessionToolState` over a fresh fake, for binding a controller in tests. */
export function fakeToolState(initial: AgentHarnessTool<ExecutionToolContext>[]): SessionToolState {
    return new SessionToolState(new FakeToolCollection(initial));
}
