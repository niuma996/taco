/**
 * SessionRegistry.updateSkills — the workspace-level hook skill hot reload
 * calls into. Verifies the skill list backing a *freshly-built* `skill` tool
 * reflects whatever updateSkills() last set, without reconstructing
 * SessionRegistry itself.
 *
 * (Whether an *already-built* tool object also sees the swap is covered by
 * skillTool.liveLookup.test.ts — createSkillTool's getSkills is a thunk over
 * `this.skills`, so updateSkills reassigning that field is what makes both
 * true at once.)
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Skill } from "@earendil-works/pi-agent-core";
import { JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createModels } from "@earendil-works/pi-ai/compat";
import type { WorkspaceId } from "@taco-ai/protocol";
import { SessionRegistry, type SessionRegistryOptions } from "../../src/runtime/sessionRegistry.ts";
import type { TacoSkill } from "../../src/skills/tacoSkill.ts";

function mkSkill(name: string): TacoSkill {
    return {
        name,
        description: `${name} desc`,
        filePath: `/tmp/${name}/SKILL.md`,
        content: `# ${name}`,
        source: "user",
    };
}

let cwd: string;
let sessionsRoot: string;
let repo: JsonlSessionRepo;
let env: NodeExecutionEnv;
let models: ReturnType<typeof createModels>;

beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "taco-sr-reload-cwd-"));
    sessionsRoot = mkdtempSync(join(tmpdir(), "taco-sr-reload-sessions-"));
    env = new NodeExecutionEnv({ cwd });
    repo = new JsonlSessionRepo({ fs: env, sessionsRoot });
    models = createModels();
});

afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(sessionsRoot, { recursive: true, force: true });
});

function makeRegistry(overrides: Partial<SessionRegistryOptions> = {}): SessionRegistry {
    return new SessionRegistry({
        cwd: cwd as WorkspaceId,
        repo,
        sessionsRoot,
        env,
        models,
        systemPrompt: "test prompt",
        tools: [],
        resources: {},
        streamOptions: {},
        spawnSubagent: async () => ({ subSessionId: "stub-sub", resultText: "", isError: true }),
        resumeSubagent: async () => ({ subSessionId: "stub-sub", resultText: "", isError: true }),
        spawnSkillSubagent: async () => ({
            subSessionId: "stub-sub",
            resultText: "",
            isError: true,
        }),
        availableAgentTypes: [],
        skills: [mkSkill("alpha")],
        getToolContext: () => ({ env, workspace: cwd as WorkspaceId }),
        ...overrides,
    });
}

async function findSkillTool(sr: SessionRegistry) {
    const listing = sr.getListingTools();
    const tool = listing.find((t) => t.name === "skill");
    assert.ok(tool, "expected a skill tool in getListingTools()");
    return tool as (typeof listing)[number] & {
        execute: (id: string, params: { skill: string }, signal?: AbortSignal) => Promise<unknown>;
    };
}

describe("SessionRegistry.updateSkills", () => {
    it("a tool built after updateSkills() resolves the new list and not the old one", async () => {
        const sr = makeRegistry();

        const before = await findSkillTool(sr);
        const beforeResult = (await before.execute("tc-1", { skill: "beta" })) as {
            details?: { found: boolean };
        };
        assert.equal(beforeResult.details?.found, false, "beta not loaded yet");

        sr.updateSkills([mkSkill("beta")]);

        const after = await findSkillTool(sr);
        const afterFound = (await after.execute("tc-2", { skill: "beta" })) as {
            details?: { found: boolean };
        };
        assert.equal(afterFound.details?.found, true, "beta should resolve after updateSkills");

        const afterStale = (await after.execute("tc-3", { skill: "alpha" })) as {
            details?: { found: boolean };
        };
        assert.equal(
            afterStale.details?.found,
            false,
            "alpha should no longer resolve after updateSkills replaced the list",
        );
    });

    it("does not mutate the array instance passed to the original constructor call", () => {
        const originalSkills: TacoSkill[] = [mkSkill("alpha")];
        const sr = makeRegistry({ skills: originalSkills });
        sr.updateSkills([mkSkill("beta")]);
        // updateSkills reassigns the private field; it must not have gone
        // back and spliced the caller's original array.
        assert.equal(originalSkills.length, 1);
        assert.equal((originalSkills[0] as Skill).name, "alpha");
    });

    it("updates the resources passed to a subsequently-attached AgentHarness", () => {
        const sr = makeRegistry({
            resources: { skills: [mkSkill("alpha")] },
        });

        sr.updateSkills([mkSkill("beta")]);

        assert.equal(sr.resources.skills?.[0]?.name, "beta");
        assert.equal(sr.resources.skills?.length, 1);
    });
});
