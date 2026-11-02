import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { asSessionId } from "@taco-ai/protocol";
import {
    buildSessionTaskState,
    type SessionTaskState,
} from "../../src/runtime/session/sessionTaskState.ts";
import type { ChildAttachDeps } from "../../src/runtime/subagent/childAttach.ts";
import { prepareChildAttach } from "../../src/runtime/subagent/childAttach.ts";
import type { TacoTool } from "../../src/tools/index.ts";

/**
 * A tool stub with just enough shape for the prompt builder. The child attach
 * path only reads names and `taco` metadata off them.
 */
function fakeTool(name: string): TacoTool {
    return {
        name,
        label: name,
        description: `fake ${name}`,
        parameters: {} as never,
        execute: (async () => ({ content: [] })) as never,
    };
}

describe("prepareChildAttach — capability statement", () => {
    let root: string;
    let taskState: SessionTaskState;

    before(async () => {
        root = mkdtempSync(join(tmpdir(), "taco-child-attach-"));
        taskState = await buildSessionTaskState(asSessionId("s1"), root);
    });

    after(() => {
        rmSync(root, { recursive: true, force: true });
    });

    function depsFor(tools: TacoTool[]): ChildAttachDeps {
        return {
            toolsForChildSession: async () => ({ tools, taskState }),
            systemPromptContributors: [],
            projectContext: "",
            hideWorkspacePath: undefined,
            getParentInstructionsBlock: () => "",
        };
    }

    async function attach(
        agentType: string | undefined,
        toolNames: string[],
        rolePrompt?: string,
    ): Promise<string> {
        const tools = toolNames.map(fakeTool);
        const { systemPrompt } = await prepareChildAttach(depsFor(tools), {
            sessionId: asSessionId("s1"),
            agentType,
            childDepth: 1,
            allowedTools: tools,
            ...(rolePrompt !== undefined ? { rolePrompt } : {}),
            modelIdentity: "test/model",
        });
        return systemPrompt;
    }

    it("tells a read-only profile it cannot write files", async () => {
        const prompt = await attach("reviewer", ["read", "grep", "glob", "shell"]);
        assert.match(prompt, /<capabilities>/);
        assert.match(prompt, /no file-writing tools/);
        assert.match(prompt, /your shell is read-only/);
        assert.match(prompt, /no file was written/);
    });

    it("does not claim the shell is read-only for a non-gated profile", async () => {
        const prompt = await attach("verification", ["read", "grep", "glob", "shell"]);
        assert.match(prompt, /no file-writing tools/);
        assert.ok(!prompt.includes("your shell is read-only"));
        // A profile with a working shell genuinely can write a file through
        // it, so it must not be told it cannot.
        assert.ok(!prompt.includes("you cannot do it"));
    });

    it("stays silent when the profile can write", async () => {
        const prompt = await attach("builder", ["read", "write", "edit"]);
        assert.ok(!prompt.includes("<capabilities>"));
    });

    it("places the statement before the role body so the profile still wins", async () => {
        const prompt = await attach("reviewer", ["read", "grep"], "ROLE BODY MARKER");
        assert.ok(
            prompt.indexOf("<capabilities>") < prompt.indexOf("ROLE BODY MARKER"),
            "capability statement must come before the role body",
        );
    });
});
