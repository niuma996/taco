import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { asSessionId, asWorkspaceId } from "@taco-ai/protocol";
import { loadAgents } from "../../src/agents/loadAgents.ts";
import { resolveWorkspaceConfigSources } from "../../src/config/workspaceConfigSources.ts";
import { harnessContext } from "../../src/lib/harnessContext.ts";
import { ProviderKeyStore } from "../../src/runtime/models/providerKeyStore.ts";
import type {
    ClaudeAgentSdk,
    SdkQueryOptions,
} from "../../src/runtime/subagent/claudeCode/claudeCodeSdk.ts";
import { WorkspaceRuntime } from "../../src/runtime/workspace.ts";
import { createWorkspaceScope } from "../../src/workspace/workspaceScope.ts";
import { useTempTacoHome } from "../_helpers/tempTacoHome.ts";

describe("Claude Code worktree isolation", () => {
    const home = useTempTacoHome("cc-worktree");
    it("blocks inherited main cwd and honors current associated grants through AgentSpawner", async (t) => {
        const root = await realpath(await mkdtemp(join(tmpdir(), "taco-cc-isolation-")));
        t.after(() => rm(root, { recursive: true, force: true }));
        const main = join(root, "main");
        const worktree = join(main, ".taco", "worktrees", "topic");
        const associated = join(root, "associated");
        await mkdir(main);
        await mkdir(associated);
        const git = (...args: string[]) =>
            execFileSync("git", ["-C", main, ...args], { stdio: "pipe" });
        git("init", "-b", "main");
        git(
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "--allow-empty",
            "-m",
            "initial",
        );
        git("worktree", "add", "-b", "topic", worktree);
        const agentDir = join(main, ".taco", "agents");
        await mkdir(agentDir, { recursive: true });
        await writeFile(
            join(agentDir, "inherited.md"),
            `---\nname: inherited\nruntime: claude-code\ntools: []\ncwd: ${JSON.stringify(main)}\n---\nReview code\n`,
        );
        const sources = resolveWorkspaceConfigSources(worktree, main);
        const agents = await loadAgents({
            builtinDir: join(root, "builtin"),
            userDirs: sources.agentDirs,
        });
        let roots = [main, root, associated];
        const runtime = new WorkspaceRuntime({
            scope: createWorkspaceScope(asWorkspaceId(worktree), worktree, worktree, main),
            providerKeyStore: new ProviderKeyStore({}),
            sessionsRoot: join(home, "sessions"),
            agents,
            tools: [],
            resolveAssociatedRoots: () => roots,
        });
        t.after(() => runtime.dispose());
        const queries: SdkQueryOptions[] = [];
        const sdk: ClaudeAgentSdk = {
            query({ options }) {
                queries.push(options);
                return (async function* () {
                    yield {
                        type: "system" as const,
                        subtype: "init",
                        session_id: "isolated-native",
                    };
                    yield {
                        type: "assistant" as const,
                        message: {
                            id: "answer",
                            content: [{ type: "text" as const, text: "Reviewed" }],
                        },
                    };
                    yield {
                        type: "result" as const,
                        subtype: "success",
                        is_error: false,
                        num_turns: 1,
                    };
                })();
            },
        };
        const spawner = runtime.agentSpawner as unknown as {
            loadClaudeCodeSdk: () => Promise<ClaudeAgentSdk>;
            findClaudeCode: () => string | undefined;
        };
        spawner.loadClaudeCodeSdk = async () => sdk;
        spawner.findClaudeCode = () => join(root, "claude");
        const parent = asSessionId("isolation-parent");
        const session = await runtime.repo.create({ id: parent, cwd: worktree }, harnessContext);
        await session.close(harnessContext);
        const spawn = () =>
            runtime.agentSpawner.spawnSubagent({
                parentSessionId: parent,
                parentToolCallId: "spawn",
                agentType: "inherited",
                prompt: "review",
            });
        assert.deepEqual(runtime.associatedRoots(), [associated]);
        const blocked = await spawn();
        assert.equal(blocked.isError, true);
        assert.match(blocked.resultText, /associated directories/);
        assert.equal(queries.length, 0);
        runtime.agentSpawner.replaceAgents([{ ...agents[0], cwd: undefined }]);
        const local = await spawn();
        assert.equal(local.isError, false, local.resultText);
        assert.equal(queries[0]?.cwd, worktree);
        runtime.agentSpawner.replaceAgents([{ ...agents[0], cwd: associated }]);
        const child = await spawn();
        assert.equal(child.isError, false, child.resultText);
        assert.equal(queries[1]?.cwd, associated);
        assert.ok(child.subSessionId);
        roots = [main];
        const resumed = await runtime.agentSpawner.resumeSubagent({
            parentSessionId: parent,
            parentToolCallId: "resume",
            subSessionId: child.subSessionId,
            prompt: "continue",
        });
        assert.equal(resumed.isError, true);
        assert.match(resumed.resultText, /associated directories/);
        assert.equal(queries.length, 2);
    });
});
