import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { asSessionId } from "@taco-ai/protocol";
import { agentToolPolicy } from "../../src/agents/filterTools.ts";
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

    it("keeps the read-only shell's tool description and routing guide consistent", async () => {
        const tools = ["read", "grep", "glob", "shell"].map(fakeTool);
        const attached = await prepareChildAttach(depsFor(tools), {
            sessionId: asSessionId("s1"),
            agentType: "reviewer",
            childDepth: 1,
            allowedTools: tools,
            modelIdentity: "test/model",
        });
        const shell = attached.tools.find((tool) => tool.name === "shell");
        assert.ok(shell);
        assert.match(shell.description, /read-only/);
        assert.match(shell.description, /builds, tests, and writes are denied/);
        assert.ok(!shell.description.includes("prompt for approval"));
        assert.match(attached.systemPrompt, /shell \[read-only\]/);
        assert.ok(!attached.systemPrompt.includes("commands prompt for approval"));
    });

    it("does not claim the shell is read-only for a non-gated profile", async () => {
        const prompt = await attach("verification", ["read", "grep", "glob", "shell"]);
        assert.match(prompt, /no `write` \/ `edit` tools/);
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

    it("lists only the deferred tools the profile may load", async () => {
        const tools = ["read", "grep"].map(fakeTool);
        const deps: ChildAttachDeps = {
            ...depsFor(tools),
            getDeferredToolCatalog: () => [
                { name: "pdfMerge", summary: "merge PDFs" },
                { name: "configPatch", summary: "patch config" },
            ],
        };
        const { systemPrompt } = await prepareChildAttach(deps, {
            sessionId: asSessionId("s1"),
            agentType: "builder",
            childDepth: 1,
            allowedTools: tools,
            toolPolicy: agentToolPolicy(["read", "grep", "pdfMerge"], 1),
            modelIdentity: "test/model",
        });
        assert.match(systemPrompt, /<deferred_tools>/);
        assert.match(systemPrompt, /pdfMerge/);
        assert.ok(
            !systemPrompt.includes("configPatch"),
            "a tool outside the profile's declaration must not be advertised",
        );
    });

    it("counts a loadable deferred writer, so the child is not told it cannot write", async () => {
        const tools = ["read", "grep"].map(fakeTool);
        const deps: ChildAttachDeps = {
            ...depsFor(tools),
            getDeferredToolCatalog: () => [{ name: "pdfMerge", summary: "merge PDFs" }],
        };
        const { systemPrompt } = await prepareChildAttach(deps, {
            sessionId: asSessionId("s1"),
            agentType: "builder",
            childDepth: 1,
            allowedTools: tools,
            toolPolicy: agentToolPolicy(["read", "grep", "pdfMerge"], 1),
            modelIdentity: "test/model",
        });
        // The same prompt lists pdfMerge as loadable; a "you cannot write a
        // file" directive next to that listing would be two instructions
        // that disagree.
        assert.match(systemPrompt, /no `write` \/ `edit` tools/);
        assert.match(systemPrompt, /file-producing tools/);
        assert.ok(!systemPrompt.includes("you cannot do it"));
    });

    it("keeps the read-only directive when the deferred writer is not loadable", async () => {
        const tools = ["read", "grep"].map(fakeTool);
        const deps: ChildAttachDeps = {
            ...depsFor(tools),
            getDeferredToolCatalog: () => [{ name: "pdfMerge", summary: "merge PDFs" }],
        };
        const { systemPrompt } = await prepareChildAttach(deps, {
            sessionId: asSessionId("s1"),
            agentType: "reviewer",
            childDepth: 1,
            allowedTools: tools,
            toolPolicy: agentToolPolicy(["read", "grep"], 1),
            modelIdentity: "test/model",
        });
        assert.match(systemPrompt, /you cannot do it/);
    });
});
