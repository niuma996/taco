/**
 * Read-only shell gate — every builtin profile that claims read-only in its
 * body must be inside READ_ONLY_SHELL_AGENT_TYPES. Prose is not a permission
 * boundary: a profile that says "do not modify files" but is missing from the
 * gate still receives a shell bound to the user's root-session allowlist.
 *
 * Run: cd packages/sidecar && pnpm exec tsx --test tests/agents/readOnlyShellGate.test.ts
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadAgents } from "../../src/agents/loadAgents.ts";
import { READ_ONLY_SHELL_AGENT_TYPES } from "../../src/runtime/agentSpawner.ts";

const BUILTIN_DIR = join(import.meta.dirname, "..", "..", "src", "agents", "builtin");

/**
 * The banner a profile uses to claim it cannot write anything at all.
 *
 * Deliberately narrower than "mentions not modifying files": `verification`
 * says "DO NOT MODIFY THE PROJECT" yet must keep a writable shell, since it
 * runs builds and writes ephemeral scripts to /tmp. Only the absolute
 * no-modifications banner implies the read-only broker.
 */
const READ_ONLY_BANNER = /READ-ONLY MODE - NO FILE MODIFICATIONS/i;

describe("read-only shell gate", () => {
    it("every builtin profile granted shell that claims read-only is gated", async () => {
        // userDirs: [] — same rationale as server.agents.test.ts, avoids host-fs drift.
        const agents = await loadAgents({ builtinDir: BUILTIN_DIR, userDirs: [] });
        assert.ok(agents.length > 0, "expected builtin agents to load");

        const ungated: string[] = [];
        for (const a of agents) {
            const grantsShell = a.tools === undefined || a.tools.includes("shell");
            const claimsReadOnly = READ_ONLY_BANNER.test(a.systemPrompt);
            if (grantsShell && claimsReadOnly && !READ_ONLY_SHELL_AGENT_TYPES.has(a.agentType)) {
                ungated.push(a.agentType);
            }
        }
        assert.deepEqual(
            ungated,
            [],
            `these profiles claim read-only and hold shell but are not in READ_ONLY_SHELL_AGENT_TYPES: ${ungated.join(", ")}`,
        );
    });

    it("reviewer is gated — it holds shell and its body forbids writes", async () => {
        const agents = await loadAgents({ builtinDir: BUILTIN_DIR, userDirs: [] });
        const reviewer = agents.find((a) => a.agentType === "reviewer");
        assert.ok(reviewer, "expected the reviewer builtin");
        assert.ok(reviewer.tools?.includes("shell"), "reviewer is granted shell");
        assert.equal(READ_ONLY_SHELL_AGENT_TYPES.has("reviewer"), true);
    });

    it("verification is NOT gated — it must keep a writable shell", () => {
        // It runs builds and writes ephemeral scripts to /tmp; swapping in the
        // read-only broker would make the profile unable to do its job.
        assert.equal(READ_ONLY_SHELL_AGENT_TYPES.has("verification"), false);
    });

    it("reviewer defaults to forked context", async () => {
        const agents = await loadAgents({ builtinDir: BUILTIN_DIR, userDirs: [] });
        const reviewer = agents.find((a) => a.agentType === "reviewer");
        assert.equal(reviewer?.context, "fork");
    });
});
