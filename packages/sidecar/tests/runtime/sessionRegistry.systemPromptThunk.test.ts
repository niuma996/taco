/**
 * SessionRegistry reads the workspace's system prompt through a thunk, not a
 * snapshot.
 *
 * `WorkspaceRuntime.refreshToolset()` / `reloadSkillsNow()` rebuild the baked
 * prompt after construction. `SessionRegistry` used to copy that string at
 * construction (`getSystemPrompt: () => this.systemPrompt` was
 * `systemPrompt: this.systemPrompt`), so a session attached *after* one of
 * those rebuilds still got the *previous* prompt handed to `attachChild` —
 * the exact tool/prompt mismatch `refreshToolset` exists to prevent, just on
 * the attach path instead of the per-turn one.
 *
 * `AttachedSession.create` is stubbed to capture the prompt it was given
 * without needing a real model call — same technique as
 * agentSpawner.instructionsThunk.test.ts and .toolsThunk.test.ts.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createModels } from "@earendil-works/pi-ai/compat";
import type { WorkspaceId } from "@taco-ai/protocol";
import { harnessContext } from "../../src/lib/harnessContext.ts";
import { AttachedSession } from "../../src/runtime/harness/attachedSession.ts";
import { NodeExecutionEnv } from "../../src/runtime/pi/node.ts";
import { JsonlSessionRepo, uuidv7 } from "../../src/runtime/pi/values.ts";
import {
    SessionRegistry,
    type SessionRegistryOptions,
} from "../../src/runtime/session/sessionRegistry.ts";
import type { TacoTool } from "../../src/tools/index.ts";

const fakeTool = (name: string): TacoTool =>
    ({
        name,
        label: name,
        description: "fake",
        parameters: {},
        async execute() {
            return { content: [{ type: "text", text: "" }], details: {} };
        },
    }) as unknown as TacoTool;

describe("SessionRegistry system-prompt thunk", () => {
    let cwd: string;
    let sessionsRoot: string;
    let repo: JsonlSessionRepo;
    let env: NodeExecutionEnv;
    let models: ReturnType<typeof createModels>;
    let originalCreate: typeof AttachedSession.create;
    /** systemPrompt strings AttachedSession.create was called with, in order. */
    let captured: (string | (() => string) | undefined)[];

    beforeEach(() => {
        cwd = mkdtempSync(join(tmpdir(), "taco-sr-prompt-cwd-"));
        sessionsRoot = mkdtempSync(join(tmpdir(), "taco-sr-prompt-sessions-"));
        env = new NodeExecutionEnv({ cwd });
        repo = new JsonlSessionRepo({ fileSystem: env, sessionsRoot });
        models = createModels();
        captured = [];
        originalCreate = AttachedSession.create;
        AttachedSession.create = (async (args: Parameters<typeof AttachedSession.create>[0]) => {
            captured.push(args.systemPrompt);
            throw new Error("stubbed — no real harness needed for this test");
        }) as typeof AttachedSession.create;
    });

    afterEach(() => {
        AttachedSession.create = originalCreate;
        rmSync(cwd, { recursive: true, force: true });
        rmSync(sessionsRoot, { recursive: true, force: true });
    });

    function makeRegistry(currentPrompt: () => string): SessionRegistry {
        return new SessionRegistry({
            cwd: cwd as WorkspaceId,
            repo,
            sessionsRoot,
            env,
            models,
            getSystemPrompt: currentPrompt,
            tools: [fakeTool("fake-tool")],
            resources: {},
            streamOptions: {},
            spawnSubagent: async () => ({ subSessionId: "", resultText: "", isError: true }),
            resumeSubagent: async () => ({ subSessionId: "", resultText: "", isError: true }),
            spawnSkillSubagent: async () => ({ subSessionId: "", resultText: "", isError: true }),
            availableAgentTypes: [],
            skills: [],
            getToolContext: () => ({ env, workspace: cwd as WorkspaceId }),
        } satisfies SessionRegistryOptions);
    }

    it("a session attached after a prompt rebuild gets the rebuilt prompt, not the constructor-time one", async () => {
        // Simulates WorkspaceRuntime: `prompt` starts as the "constructor-time"
        // value and is later reassigned by refreshToolset()/reloadSkillsNow(),
        // exactly like `this.systemPrompt = this.rebuildSystemPrompt(...)`.
        let prompt = "prompt v1 (constructor time)";
        const sr = makeRegistry(() => prompt);

        const id1 = uuidv7();
        await sr.repo.create({ id: id1, cwd }, harnessContext).then((s) => s.close(harnessContext));
        sr.invalidateListCache();
        await assert.rejects(() => sr.attach(id1));
        assert.equal(captured.at(-1), "prompt v1 (constructor time)");

        // The workspace rebuilds its prompt (a policy grant, a skill reload) —
        // no attach has happened yet for this session.
        prompt = "prompt v2 (rebuilt after a policy change)";

        const id2 = uuidv7();
        await sr.repo.create({ id: id2, cwd }, harnessContext).then((s) => s.close(harnessContext));
        sr.invalidateListCache();
        await assert.rejects(() => sr.attach(id2));
        assert.equal(
            captured.at(-1),
            "prompt v2 (rebuilt after a policy change)",
            "a session attached after the rebuild must see the current prompt, not the one captured when SessionRegistry was constructed",
        );
    });
});
