import assert from "node:assert/strict";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { AgentsWriteParams } from "@taco-ai/protocol";
import { loadAgentDir } from "../../../src/agents/loadAgents.ts";
import type { AgentDefinition } from "../../../src/agents/types.ts";
import {
    deleteUserAgent,
    readUserAgent,
    userAgentsDir,
    writeUserAgent,
} from "../../../src/server/handlers/agentsWrite.ts";

describe("agent layer CRUD", () => {
    let home: string;
    let project: string;
    let previousHome: string | undefined;

    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), "taco-agent-layers-home-"));
        project = mkdtempSync(join(tmpdir(), "taco-agent-layers-project-"));
        previousHome = process.env.TACO_HOME;
        process.env.TACO_HOME = home;
    });
    afterEach(() => {
        if (previousHome === undefined) delete process.env.TACO_HOME;
        else process.env.TACO_HOME = previousHome;
        rmSync(home, { recursive: true, force: true });
        rmSync(project, { recursive: true, force: true });
    });

    const projectAgentsDir = () => join(project, ".taco", "agents");
    const ctx = () => ({ workspaceDir: project });
    const def = (over: Partial<AgentDefinition> = {}): AgentDefinition => ({
        agentType: "shared",
        description: "original",
        systemPrompt: "prompt",
        source: "user",
        filePath: join(userAgentsDir(), "shared.md"),
        ...over,
    });
    const params = (over: Partial<AgentsWriteParams> = {}): AgentsWriteParams => ({
        workspace: project as AgentsWriteParams["workspace"],
        agentType: "custom-agent",
        description: "original",
        runtime: "standard",
        maxTurns: 30,
        systemPrompt: "prompt",
        ...over,
    });

    for (const scope of ["global", "workspace"] as const) {
        it(`reads and edits the actual ${scope} file when its name differs from the agent type`, async () => {
            const dir = scope === "global" ? userAgentsDir() : projectAgentsDir();
            mkdirSync(dir, { recursive: true });
            const filePath = join(dir, "custom-file.md");
            writeFileSync(
                filePath,
                "---\nname: custom-agent\ndescription: original\n---\nprompt\n",
            );
            const original = await readUserAgent("custom-agent", scope, ctx());
            assert.equal(original.filePath, filePath);
            await writeUserAgent(
                params({
                    agentType: "custom-agent",
                    previousAgentType: "custom-agent",
                    previousScope: scope,
                    scope,
                    description: "updated",
                }),
                [],
                ctx(),
            );
            assert.deepEqual(readdirSync(dir), ["custom-file.md"]);
            assert.equal(
                (await readUserAgent("custom-agent", scope, ctx())).description,
                "updated",
            );
        });

        it(`renames the selected ${scope} custom file without leaving its original behind`, async () => {
            const dir = scope === "global" ? userAgentsDir() : projectAgentsDir();
            mkdirSync(dir, { recursive: true });
            const original = join(dir, "custom-file.md");
            writeFileSync(
                original,
                "---\nname: custom-agent\ndescription: original\n---\nprompt\n",
            );
            await writeUserAgent(
                params({
                    agentType: "renamed-agent",
                    previousAgentType: "custom-agent",
                    previousScope: scope,
                    scope,
                }),
                [],
                ctx(),
            );
            assert.deepEqual(readdirSync(dir), ["renamed-agent.md"]);
            assert.equal(
                (await readUserAgent("renamed-agent", scope, ctx())).agentType,
                "renamed-agent",
            );
        });

        it(`deletes the actual ${scope} file without deleting the other layer's override`, async () => {
            const selectedDir = scope === "global" ? userAgentsDir() : projectAgentsDir();
            const otherDir = scope === "global" ? projectAgentsDir() : userAgentsDir();
            for (const dir of [selectedDir, otherDir]) {
                mkdirSync(dir, { recursive: true });
                writeFileSync(
                    join(dir, "custom-file.md"),
                    "---\nname: custom-agent\ndescription: original\n---\nprompt\n",
                );
            }
            await deleteUserAgent("custom-agent", [], ctx(), scope);
            assert.equal(existsSync(join(selectedDir, "custom-file.md")), false);
            assert.equal(existsSync(join(otherDir, "custom-file.md")), true);
        });
    }

    it("edits and deletes an effective custom file without an explicit scope", async () => {
        mkdirSync(userAgentsDir(), { recursive: true });
        const filePath = join(userAgentsDir(), "custom-file.md");
        writeFileSync(filePath, "---\nname: custom-agent\ndescription: original\n---\nprompt\n");
        await writeUserAgent(
            params({
                agentType: "custom-agent",
                previousAgentType: "custom-agent",
                description: "updated",
            }),
            await loadAgentDir(userAgentsDir(), "user"),
            ctx(),
        );
        assert.deepEqual(readdirSync(userAgentsDir()), ["custom-file.md"]);
        assert.match(readFileSync(filePath, "utf8"), /updated/);
        await deleteUserAgent("custom-agent", await loadAgentDir(userAgentsDir(), "user"), ctx());
        assert.equal(existsSync(filePath), false);
    });

    it("moves a custom file between layers without leaving the old definition", async () => {
        mkdirSync(userAgentsDir(), { recursive: true });
        const filePath = join(userAgentsDir(), "custom-file.md");
        writeFileSync(filePath, "---\nname: custom-agent\ndescription: original\n---\nprompt\n");
        await writeUserAgent(
            params({
                previousAgentType: "custom-agent",
                previousScope: "global",
                scope: "workspace",
            }),
            await loadAgentDir(userAgentsDir(), "user"),
            ctx(),
        );
        assert.equal(existsSync(filePath), false);
        assert.deepEqual(readdirSync(projectAgentsDir()), ["custom-agent.md"]);
    });

    it("refuses a move onto a definition stored under a different filename", async () => {
        for (const dir of [userAgentsDir(), projectAgentsDir()]) {
            mkdirSync(dir, { recursive: true });
            writeFileSync(
                join(dir, "custom-file.md"),
                "---\nname: custom-agent\ndescription: original\n---\nprompt\n",
            );
        }
        await assert.rejects(
            writeUserAgent(
                params({
                    previousAgentType: "custom-agent",
                    previousScope: "global",
                    scope: "workspace",
                }),
                await loadAgentDir(projectAgentsDir(), "user"),
                ctx(),
            ),
            /already exists in the workspace directory/,
        );
        assert.deepEqual(readdirSync(userAgentsDir()), ["custom-file.md"]);
        assert.deepEqual(readdirSync(projectAgentsDir()), ["custom-file.md"]);
    });

    for (const runtime of ["claude-code", "codex"] as const) {
        it(`keeps a shadowed global ${runtime} cwd when editing only its description`, async () => {
            const outside = join(home, "other-workspace");
            mkdirSync(outside);
            mkdirSync(userAgentsDir(), { recursive: true });
            const settings = runtime === "codex" ? { codex: { cwd: outside } } : { cwd: outside };
            await writeUserAgent(params({ agentType: "shared", runtime, ...settings }), [], {
                ...ctx(),
                allowedCwds: [outside],
            });
            await writeUserAgent(
                params({
                    agentType: "shared",
                    scope: "workspace",
                    runtime,
                    ...(runtime === "codex" ? { codex: { cwd: project } } : { cwd: project }),
                }),
                [def({ agentType: "shared" })],
                { ...ctx(), allowedCwds: [project] },
            );
            await writeUserAgent(
                params({
                    agentType: "shared",
                    previousAgentType: "shared",
                    previousScope: "global",
                    scope: "global",
                    runtime,
                    ...settings,
                    description: "updated",
                }),
                await loadAgentDir(projectAgentsDir(), "user"),
                { ...ctx(), allowedCwds: [project] },
            );
            const saved = await readUserAgent("shared", "global", ctx());
            assert.equal(saved.description, "updated");
            assert.equal(runtime === "codex" ? saved.codex?.cwd : saved.cwd, outside);
        });

        it(`does not borrow a different layer's ${runtime} cwd to bypass validation`, async () => {
            const outside = join(home, "other-workspace");
            mkdirSync(outside);
            const globalSettings =
                runtime === "codex" ? { codex: { cwd: project } } : { cwd: project };
            const localSettings =
                runtime === "codex" ? { codex: { cwd: outside } } : { cwd: outside };
            await writeUserAgent(params({ agentType: "shared", runtime, ...globalSettings }), [], {
                ...ctx(),
                allowedCwds: [project],
            });
            await writeUserAgent(
                params({ agentType: "shared", scope: "workspace", runtime, ...localSettings }),
                [def({ agentType: "shared" })],
                { ...ctx(), allowedCwds: [outside] },
            );
            await assert.rejects(
                writeUserAgent(
                    params({
                        agentType: "shared",
                        previousAgentType: "shared",
                        previousScope: "global",
                        scope: "global",
                        runtime,
                        ...localSettings,
                    }),
                    await loadAgentDir(projectAgentsDir(), "user"),
                    { ...ctx(), allowedCwds: [project] },
                ),
                /workspace directory or one of its associated directories/,
            );
            const saved = await readUserAgent("shared", "global", ctx());
            assert.equal(runtime === "codex" ? saved.codex?.cwd : saved.cwd, project);
        });

        it(`does not trust a stale catalog's ${runtime} cwd after the source file changes`, async () => {
            const outside = join(home, "other-workspace");
            mkdirSync(outside);
            const oldSettings =
                runtime === "codex" ? { codex: { cwd: outside } } : { cwd: outside };
            const newSettings =
                runtime === "codex" ? { codex: { cwd: project } } : { cwd: project };
            await writeUserAgent(params({ runtime, ...newSettings }), [], {
                ...ctx(),
                allowedCwds: [project],
            });
            await assert.rejects(
                writeUserAgent(
                    params({ runtime, ...oldSettings, previousAgentType: "custom-agent" }),
                    [def({ agentType: "custom-agent", runtime, ...oldSettings })],
                    { ...ctx(), allowedCwds: [project] },
                ),
                /workspace directory or one of its associated directories/,
            );
        });
    }

    for (const tools of [undefined, [], ["chatToAgent"]]) {
        it(`preserves Codex tools ${JSON.stringify(tools)} through a description edit`, async () => {
            const filePath = join(userAgentsDir(), "codex-tools.md");
            mkdirSync(userAgentsDir(), { recursive: true });
            writeFileSync(
                filePath,
                `---\nname: codex-tools\ndescription: original\nruntime: codex\n${tools === undefined ? "" : `tools: ${JSON.stringify(tools)}\n`}---\nprompt\n`,
            );
            const original = await readUserAgent("codex-tools", "global");
            await writeUserAgent(
                params({
                    agentType: "codex-tools",
                    previousAgentType: "codex-tools",
                    previousScope: "global",
                    runtime: "codex",
                    tools: original.tools,
                    description: "updated",
                }),
                [original],
            );
            const saved = await readUserAgent("codex-tools", "global");
            assert.equal(saved.description, "updated");
            assert.deepEqual(saved.tools, tools);
        });
    }
});
