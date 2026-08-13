/** Minimal fake of pi-agent-core AgentHarness tool-collection surface for unit tests. */

import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core";
import type { ToolCollection } from "../../src/runtime/sessionToolController.ts";

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

    getTools(): AgentHarnessTool<ExecutionToolContext>[] {
        return [...this.tools.values()];
    }

    getActiveTools(): AgentHarnessTool<ExecutionToolContext>[] {
        // active and tools are kept in sync — cast avoids the lint noNonNullAssertion rule.
        return [...this.active].map(
            (n) => this.tools.get(n) as AgentHarnessTool<ExecutionToolContext>,
        );
    }

    async setTools(
        tools: readonly AgentHarnessTool<ExecutionToolContext>[],
        activeNames?: readonly string[],
    ): Promise<void> {
        this.tools = new Map(tools.map((t) => [t.name, t]));
        this.active = new Set(activeNames ?? tools.map((t) => t.name));
        this.setToolsCalls.push({
            tools: tools.map((t) => t.name),
            active: [...this.active],
        });
    }
}
