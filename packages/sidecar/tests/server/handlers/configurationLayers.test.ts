import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, it } from "node:test";
import type {
    AgentsContentResult,
    AgentsListResult,
    SkillContentResult,
    SkillsListResult,
} from "@taco-ai/protocol";
import { asWorkspaceId } from "@taco-ai/protocol";
import { ProviderKeyStore } from "../../../src/runtime/models/providerKeyStore.ts";
import { registerBuiltinMethods } from "../../../src/server/methods.ts";
import { SidecarServer } from "../../../src/server/server.ts";
import { readSkillFrontmatter } from "../../../src/skills/skillFrontmatter.ts";
import { callMethod } from "../../_helpers/handlerCall.ts";
import { useTempTacoHome } from "../../_helpers/tempTacoHome.ts";

const home = useTempTacoHome("config-layers");
before(registerBuiltinMethods);

it("preserves explicit skill layer identities when global and workspace roots overlap", async () => {
    const project = mkdtempSync(join(tmpdir(), "taco-layer-overlap-"));
    const previousHome = process.env.TACO_HOME;
    const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
    const workspaceId = asWorkspaceId(project);
    try {
        process.env.TACO_HOME = join(project, ".taco");
        const dir = join(project, ".taco", "skills", "overlap-example");
        mkdirSync(dir, { recursive: true });
        const filePath = join(dir, "SKILL.md");
        writeFileSync(
            filePath,
            "---\nname: overlap-example\ndescription: shared roots\n---\nshared body\n",
        );
        const workspace = await server.ensureWorkspace(workspaceId);
        for (const scope of ["global", "workspace"] as const) {
            const listed = await callMethod<SkillsListResult>("skills.list", {
                server,
                workspace,
                params: { workspace: workspaceId, scope },
            });
            const skill = listed.skills.find((entry) => entry.name === "overlap-example");
            assert.ok(skill);
            assert.equal(skill.scope, scope);
            const content = await callMethod<SkillContentResult>("skills.content", {
                server,
                workspace,
                params: { workspace: workspaceId, scope, filePath: skill.filePath },
            });
            assert.match(content.content, /shared body/);
        }
        const effective = await callMethod<SkillsListResult>("skills.list", {
            server,
            workspace,
            params: { workspace: workspaceId },
        });
        assert.equal(
            effective.skills.find((entry) => entry.name === "overlap-example")?.scope,
            "workspace",
        );
    } finally {
        await server.stop();
        if (previousHome === undefined) Reflect.deleteProperty(process.env, "TACO_HOME");
        else process.env.TACO_HOME = previousHome;
        rmSync(project, { recursive: true, force: true });
    }
});

it("reads shadowed skill definitions from their source layer while retaining content path validation", async () => {
    const project = mkdtempSync(join(tmpdir(), "taco-layer-project-"));
    const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
    const workspaceId = asWorkspaceId(project);
    const writeSkill = (root: string, body: string) => {
        const dir = join(root, "skills", "layer-example");
        mkdirSync(dir, { recursive: true });
        const file = join(dir, "SKILL.md");
        writeFileSync(file, `---\nname: layer-example\ndescription: ${body}\n---\n${body}\n`);
        return file;
    };
    try {
        const globalFile = writeSkill(home, "global body");
        writeSkill(join(project, ".taco"), "local body");
        const workspace = await server.ensureWorkspace(workspaceId);
        const list = (scope?: string) =>
            callMethod<SkillsListResult>("skills.list", {
                server,
                workspace,
                params: { workspace: workspaceId, ...(scope ? { scope } : {}) },
            });
        assert.equal(
            (await list()).skills.find((skill) => skill.name === "layer-example")?.description,
            "local body",
        );
        const runtimeFile = join(project, ".taco", "skills", "layer-example", "SKILL.md");
        assert.equal(readSkillFrontmatter(runtimeFile).runAs, undefined);
        writeFileSync(
            runtimeFile,
            "---\nname: layer-example\ndescription: local body\nrunAs: subagent\n---\nlocal body\n",
        );
        const global = await list("global");
        assert.equal(
            global.skills.find((skill) => skill.name === "layer-example")?.description,
            "global body",
        );
        assert.ok(global.skills.every((skill) => skill.scope === "global"));
        const local = await list("workspace");
        assert.equal(
            readSkillFrontmatter(runtimeFile).runAs,
            undefined,
            "browsing source layers must not update runtime frontmatter",
        );
        assert.ok(local.skills.every((skill) => skill.scope === "workspace"));
        assert.equal(
            local.skills.find((skill) => skill.name === "layer-example")?.description,
            "local body",
        );
        const content = await callMethod<SkillContentResult>("skills.content", {
            server,
            workspace,
            params: { workspace: workspaceId, scope: "global", filePath: globalFile },
        });
        assert.match(content.content, /global body/);
        await assert.rejects(
            callMethod("skills.content", {
                server,
                workspace,
                params: {
                    workspace: workspaceId,
                    scope: "global",
                    filePath: join(project, "private.txt"),
                },
            }),
            /not available/,
        );
    } finally {
        await server.stop();
        rmSync(project, { recursive: true, force: true });
    }
});

it("lists and reads original builtin agents even when an on-disk user definition shadows one", async () => {
    const project = mkdtempSync(join(tmpdir(), "taco-layer-agents-"));
    const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
    const workspaceId = asWorkspaceId(project);
    try {
        const workspace = await server.ensureWorkspace(workspaceId);
        const builtin = workspace.agents.find((agent) => agent.source === "builtin");
        assert.ok(builtin);
        const dir = join(project, ".taco", "agents");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, `${builtin.agentType}.md`),
            `---\nname: ${builtin.agentType}\ndescription: local override\n---\nlocal prompt\n`,
        );
        await server.reloadAgents();
        const args = { server, workspace, params: { workspace: workspaceId, scope: "builtin" } };
        const listed = await callMethod<AgentsListResult>("agents.list", args);
        assert.ok(listed.agents.every((agent) => agent.source === "builtin" && !agent.editable));
        assert.equal(
            listed.agents.find((agent) => agent.agentType === builtin.agentType)?.description,
            builtin.description,
        );
        const content = await callMethod<AgentsContentResult>("agents.content", {
            ...args,
            params: { ...args.params, agentType: builtin.agentType },
        });
        assert.equal(content.systemPrompt, builtin.systemPrompt);
        assert.equal(content.editable, false);
    } finally {
        await server.stop();
        rmSync(project, { recursive: true, force: true });
    }
});

it("reads a shadowed bundled skill's original content and keeps builtin sources read-only", async () => {
    const project = mkdtempSync(join(tmpdir(), "taco-layer-builtin-"));
    const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
    const workspaceId = asWorkspaceId(project);
    try {
        const workspace = await server.ensureWorkspace(workspaceId);
        const builtin = workspace.resources.skills?.find((skill) => skill.source === "builtin");
        assert.ok(builtin);
        const dir = join(project, ".taco", "skills", builtin.name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, "SKILL.md"),
            `---\nname: ${builtin.name}\ndescription: local skill override\n---\nlocal body\n`,
        );
        await workspace.reloadSkillsNow();
        const base = { server, workspace };
        const effective = await callMethod<SkillsListResult>("skills.list", {
            ...base,
            params: { workspace: workspaceId },
        });
        assert.equal(
            effective.skills.find((skill) => skill.name === builtin.name)?.description,
            "local skill override",
        );
        const listed = await callMethod<SkillsListResult>("skills.list", {
            ...base,
            params: { workspace: workspaceId, scope: "builtin" },
        });
        assert.ok(listed.skills.every((skill) => skill.source === "builtin"));
        const original = listed.skills.find((skill) => skill.name === builtin.name);
        assert.equal(original?.filePath, builtin.filePath);
        const content = await callMethod<SkillContentResult>("skills.content", {
            ...base,
            params: { workspace: workspaceId, scope: "builtin", filePath: builtin.filePath },
        });
        assert.ok(content.content.length > 0);
        assert.doesNotMatch(content.content, /local body/);
        await assert.rejects(
            callMethod("agents.delete", {
                ...base,
                params: {
                    workspace: workspaceId,
                    agentType: "explorer",
                    scope: "builtin",
                },
            }),
            /parameter validation failed/,
        );
    } finally {
        await server.stop();
        rmSync(project, { recursive: true, force: true });
    }
});
