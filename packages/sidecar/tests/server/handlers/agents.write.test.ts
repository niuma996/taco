/**
 * agents.write / agents.delete file ops against a temp $TACO_HOME.
 * No RPC server — the handlers are thin wrappers over these functions.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { AgentsWriteParams } from "@taco-ai/protocol";
import { parseAgentMarkdown } from "../../../src/agents/loadAgents.ts";
import type { AgentDefinition } from "../../../src/agents/types.ts";
import {
    AgentWriteError,
    deleteUserAgent,
    isEditableAgent,
    userAgentsDir,
    writeUserAgent,
} from "../../../src/server/handlers/agentsWrite.ts";

function def(over: Partial<AgentDefinition> = {}): AgentDefinition {
    return {
        agentType: "x",
        description: "d",
        systemPrompt: "body",
        source: "user",
        filePath: join(userAgentsDir(), "x.md"),
        ...over,
    };
}

function params(over: Partial<AgentsWriteParams> = {}): AgentsWriteParams {
    return {
        workspace: "/w" as AgentsWriteParams["workspace"],
        agentType: "my-cc",
        description: "reads things",
        runtime: "claude-code",
        maxTurns: 30,
        systemPrompt: "You read files.",
        ...over,
    };
}

describe("agentsWrite", () => {
    let home: string;
    let prevHome: string | undefined;

    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), "taco-agents-"));
        prevHome = process.env.TACO_HOME;
        process.env.TACO_HOME = home;
    });
    afterEach(() => {
        if (prevHome === undefined) delete process.env.TACO_HOME;
        else process.env.TACO_HOME = prevHome;
        rmSync(home, { recursive: true, force: true });
    });

    it("creates <agentType>.md under $TACO_HOME/agents with parseable frontmatter", async () => {
        await writeUserAgent(params({ description: "reads: things", whenToUse: "for reads" }), []);
        const files = readdirSync(userAgentsDir());
        assert.deepEqual(files, ["my-cc.md"]);
        const text = readFileSync(join(userAgentsDir(), "my-cc.md"), "utf-8");
        assert.match(text, /runtime: claude-code/);
        assert.match(text, /maxTurns: 30/);
        // Round-trip through the real loader's parser.
        const parsed = parseAgentMarkdown(text, "x", "user");
        assert.equal(parsed?.agentType, "my-cc");
        assert.equal(parsed?.description, "reads: things");
        assert.equal(parsed?.runtime, "claude-code");
        assert.equal(parsed?.systemPrompt, "You read files.");
    });

    it("writes a standard agent with no runtime line, so it parses as the default", async () => {
        await writeUserAgent(params({ agentType: "plain", runtime: undefined }), []);
        const text = readFileSync(join(userAgentsDir(), "plain.md"), "utf-8");
        assert.doesNotMatch(text, /runtime:/);
        assert.equal(parseAgentMarkdown(text, "x", "user")?.runtime, undefined);

        await writeUserAgent(params({ agentType: "plain2", runtime: "standard" }), []);
        assert.doesNotMatch(readFileSync(join(userAgentsDir(), "plain2.md"), "utf-8"), /runtime:/);
    });

    it("round-trips claude-code tools and permission mode; defaults stay implicit", async () => {
        await writeUserAgent(
            params({ agentType: "cc-a", tools: ["Read", "Edit"], permissionMode: "acceptEdits" }),
            [],
        );
        const a = parseAgentMarkdown(
            readFileSync(join(userAgentsDir(), "cc-a.md"), "utf-8"),
            "x",
            "user",
        );
        assert.deepEqual(a?.tools, ["Read", "Edit"]);
        assert.equal(a?.permissionMode, "acceptEdits");

        await writeUserAgent(params({ agentType: "cc-b", tools: [], permissionMode: "auto" }), []);
        const text = readFileSync(join(userAgentsDir(), "cc-b.md"), "utf-8");
        assert.doesNotMatch(text, /tools:|permissionMode:/);
    });

    it("never writes Claude Code settings for a standard agent", async () => {
        await writeUserAgent(
            params({
                agentType: "std",
                runtime: "standard",
                tools: ["Read"],
                permissionMode: "bypassPermissions",
            }),
            [],
        );
        const text = readFileSync(join(userAgentsDir(), "std.md"), "utf-8");
        assert.doesNotMatch(text, /tools:|permissionMode:/);
    });

    it("rejects AskUserQuestion, which the runner always blocks", async () => {
        await assert.rejects(
            writeUserAgent(params({ tools: ["Read", "AskUserQuestion"] }), []),
            /AskUserQuestion is not available/,
        );
    });

    it("rejects tool names that are not plain identifiers", async () => {
        await assert.rejects(
            writeUserAgent(params({ tools: ["Read", "x\nrm"] }), []),
            AgentWriteError,
        );
    });

    it("rejects names that would escape the agents dir or break tooling", async () => {
        for (const bad of ["../evil", "My-Agent", "a b", "x".repeat(70)]) {
            await assert.rejects(writeUserAgent(params({ agentType: bad }), []), AgentWriteError);
        }
        assert.ok(!readdirSync(home).includes("agents"));
    });

    it("rejects a create whose agentType already exists in any source", async () => {
        await assert.rejects(
            writeUserAgent(params({ agentType: "explorer" }), [
                def({
                    agentType: "explorer",
                    source: "builtin",
                    filePath: "/pkg/builtin/explorer.md",
                }),
            ]),
            /already exists/,
        );
    });

    it("rejects editing a definition outside $TACO_HOME/agents", async () => {
        const ro = def({ agentType: "ro", filePath: "/Users/x/.claude/agents/ro.md" });
        await assert.rejects(
            writeUserAgent(params({ agentType: "ro", previousAgentType: "ro" }), [ro]),
            /not editable/,
        );
        await assert.rejects(deleteUserAgent("ro", [ro]), /not editable/);
    });

    it("renames on edit: writes the new file and removes the old one", async () => {
        await writeUserAgent(params({ agentType: "old-name" }), []);
        await writeUserAgent(
            params({ agentType: "new-name", previousAgentType: "old-name", description: "v2" }),
            [def({ agentType: "old-name" })],
        );
        assert.deepEqual(readdirSync(userAgentsDir()), ["new-name.md"]);
        assert.match(
            readFileSync(join(userAgentsDir(), "new-name.md"), "utf-8"),
            /name: "new-name"/,
        );
    });

    it("rejects a rename onto an existing agentType", async () => {
        await writeUserAgent(params({ agentType: "taken" }), []);
        await writeUserAgent(params({ agentType: "mine" }), []);
        await assert.rejects(
            writeUserAgent(params({ agentType: "taken", previousAgentType: "mine" }), [
                def({ agentType: "mine" }),
                def({ agentType: "taken" }),
            ]),
            /already exists/,
        );
    });

    it("deletes only editable definitions", async () => {
        await writeUserAgent(params(), []);
        await deleteUserAgent("my-cc", [def({ agentType: "my-cc" })]);
        assert.deepEqual(readdirSync(userAgentsDir()), []);
        await assert.rejects(deleteUserAgent("ghost", []), /not found/);
    });

    it("marks only $TACO_HOME/agents definitions as editable", () => {
        assert.equal(isEditableAgent(def()), true);
        assert.equal(isEditableAgent(def({ filePath: "/pkg/builtin/explorer.md" })), false);
    });
});
