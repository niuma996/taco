import { describe, it } from "node:test";

// Integration tests require workspace harness fixture:
// - WorkspaceRuntime with AgentSpawner
// - agentSpawner.spawnSubagent({ agentType: "explorer", ... })
// Run with:
//   pnpm --filter @taco-ai/sidecar exec tsx --test tests/agents/explorerShell.test.ts

describe.skip("explorer shell read-only enforcement", () => {
    // Requires a workspace harness that spawns an explorer agent — see header above.
    it("explorer rejects mutating shell commands", () => {});

    it("explorer blocks rm -rf /", () => {});
});
