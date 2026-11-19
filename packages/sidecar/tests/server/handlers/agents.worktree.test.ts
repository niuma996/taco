import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { type AgentsContentResult, type AgentsListResult, asWorkspaceId } from "@taco-ai/protocol";
import { loadAgents } from "../../../src/agents/loadAgents.ts";
import { resolveWorkspaceConfigSources } from "../../../src/config/workspaceConfigSources.ts";
import { ProviderKeyStore } from "../../../src/runtime/models/providerKeyStore.ts";
import { WorkspaceRuntime } from "../../../src/runtime/workspace.ts";
import { registerBuiltinMethods } from "../../../src/server/methods.ts";
import { createWorkspaceScope } from "../../../src/workspace/workspaceScope.ts";
import { callMethod } from "../../_helpers/handlerCall.ts";
import { useTempTacoHome } from "../../_helpers/tempTacoHome.ts";

describe("worktree agent scopes", () => {
    const home = useTempTacoHome("worktree-agents");
    before(registerBuiltinMethods);
    it("lists and rereads inherited agents with runtime priority, but only edits local definitions", async () => {
        const main = join(home, "main");
        const worktree = join(main, "worktrees", "topic");
        const sources = resolveWorkspaceConfigSources(worktree, main);
        const mainDir = join(main, ".taco", "agents");
        const localDir = join(worktree, ".taco", "agents");
        const write = (dir: string, name: string, body: string) => {
            mkdirSync(dir, { recursive: true });
            writeFileSync(
                join(dir, `${name}.md`),
                `---\nname: ${name}\ndescription: ${body}\n---\n${body}\n`,
            );
        };
        write(mainDir, "shared", "main");
        write(mainDir, "inherited", "inherited body");
        write(localDir, "shared", "local");
        write(join(home, "agents"), "inherited", "global");
        const runtime = new WorkspaceRuntime({
            scope: createWorkspaceScope(asWorkspaceId(worktree), worktree, worktree, main),
            providerKeyStore: new ProviderKeyStore({}),
            tools: [],
            agents: await loadAgents({
                builtinDir: join(home, "builtin"),
                userDirs: sources.agentDirs,
            }),
        });
        const server = { reloadAgents: async () => {} };
        const params = { workspace: asWorkspaceId(worktree), scope: "workspace" as const };
        try {
            const listed = await callMethod<AgentsListResult>("agents.list", {
                server,
                workspace: runtime,
                params,
            });
            assert.equal(listed.agents.length, 2);
            for (const agent of listed.agents)
                assert.equal(agent.description, runtime.findAgent(agent.agentType)?.description);
            assert.equal(
                listed.agents.find((agent) => agent.agentType === "inherited")?.scope,
                "workspace",
            );
            assert.equal(
                listed.agents.find((agent) => agent.agentType === "inherited")?.editable,
                false,
            );
            assert.equal(
                listed.agents.find((agent) => agent.agentType === "shared")?.editable,
                true,
            );
            const content = () =>
                callMethod<AgentsContentResult>("agents.content", {
                    server,
                    workspace: runtime,
                    params: { ...params, agentType: "inherited" },
                });
            assert.equal((await content()).systemPrompt, "inherited body");
            write(mainDir, "inherited", "updated body");
            assert.equal((await content()).systemPrompt, "updated body");
            assert.equal((await content()).editable, false);
            const effective = await callMethod<AgentsContentResult>("agents.content", {
                server,
                workspace: runtime,
                params: { workspace: params.workspace, agentType: "inherited" },
            });
            assert.equal(effective.scope, "workspace");
            assert.equal(effective.editable, false);
            const global = await callMethod<AgentsContentResult>("agents.content", {
                server,
                workspace: runtime,
                params: { ...params, scope: "global", agentType: "inherited" },
            });
            assert.equal(global.systemPrompt, "global");
            assert.equal(global.editable, true);

            await assert.rejects(
                callMethod("agents.delete", {
                    server,
                    workspace: runtime,
                    params: { ...params, agentType: "inherited" },
                }),
                /not found|not editable/,
            );
            const edit = {
                ...params,
                agentType: "inherited",
                previousAgentType: "inherited",
                previousScope: "workspace",
                description: "edited",
                maxTurns: 10,
                systemPrompt: "edited",
            };
            await assert.rejects(
                callMethod("agents.write", { server, workspace: runtime, params: edit }),
                /not found|not editable/,
            );
            await assert.rejects(
                callMethod("agents.write", {
                    server,
                    workspace: runtime,
                    params: { ...edit, previousScope: undefined },
                }),
                /not editable/,
            );
            await callMethod("agents.write", {
                server,
                workspace: runtime,
                params: { ...edit, previousAgentType: undefined, previousScope: undefined },
            });
            assert.ok(readFileSync(join(mainDir, "inherited.md"), "utf8").includes("updated body"));
            assert.ok(readFileSync(join(localDir, "inherited.md"), "utf8").includes("edited"));
            assert.equal((await content()).editable, true);
            assert.equal((await content()).systemPrompt, "edited");
        } finally {
            await runtime.dispose();
        }
    });
});
