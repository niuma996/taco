/**
 * verify that loadAgents — called from the production-style path —
 * finds the builtin agents under src/agents/builtin.
 * Run: cd packages/sidecar && pnpm exec tsx --test tests/server/server.agents.test.ts
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadAgents } from "../../src/agents/loadAgents.ts";

describe("server.ts agent loading path", () => {
    it("loads the builtin agents from src/agents/builtin", async () => {
        const builtinDir = join(import.meta.dirname, "..", "..", "src", "agents", "builtin");
        // userDirs: [] — intentionally skips host ~/.claude / ~/.pi / ~/.taco/agents
        // to avoid host-fs drift on dev machines contaminating the builtin assertions.
        const agents = await loadAgents({ builtinDir, userDirs: [] });
        const types = agents.map((a) => a.agentType).sort();
        assert.deepEqual(types, ["explorer", "verification"]);
    });
});
