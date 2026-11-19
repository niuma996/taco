import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadAgents } from "../../src/agents/loadAgents.ts";
import { resolveInstructions } from "../../src/config/instructions.ts";
import type {
    SkillDirInput,
    WorkspaceConfigSources,
} from "../../src/config/workspaceConfigSources.ts";
import { formatSkillAuthoringGuidance } from "../../src/prompts/skillAuthoringGuidance.ts";
import { resourceRoot } from "../../src/runtime/runtimeResources.ts";
import { loadSkillCatalog } from "../../src/skills/skillCatalog.ts";

const envKeys = ["HOME", "USERPROFILE", "TACO_HOME", "TACO_SIDECAR_RESOURCES"] as const;
const fwd = (path: string) => path.replace(/\\/g, "/");

describe("workspace configuration sources", () => {
    let root: string;
    let cwd: string;
    let userHome: string;
    let tacoHome: string;
    let resources: string;
    let previousEnv: Array<string | undefined>;

    beforeEach(() => {
        previousEnv = envKeys.map((key) => process.env[key]);
        root = mkdtempSync(join(tmpdir(), "taco-config-sources-"));
        cwd = join(root, "project");
        userHome = join(root, "home");
        tacoHome = join(root, "taco-home");
        resources = join(root, "resources");
        for (const dir of [cwd, userHome, tacoHome, resources]) {
            mkdirSync(dir, { recursive: true });
        }
        process.env.HOME = userHome;
        process.env.USERPROFILE = userHome;
        process.env.TACO_HOME = tacoHome;
        process.env.TACO_SIDECAR_RESOURCES = resources;
    });

    afterEach(() => {
        envKeys.forEach((key, index) => {
            const value = previousEnv[index];
            if (value === undefined) Reflect.deleteProperty(process.env, key);
            else process.env[key] = value;
        });
        rmSync(root, { recursive: true, force: true });
    });

    function write(dir: string, name: string, body: string): void {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, name), body);
    }

    function writeSkill(dir: string, name: string, description: string): void {
        write(
            join(dir, name),
            "SKILL.md",
            `---\nname: ${name}\ndescription: ${description}\n---\nBody`,
        );
    }

    function injectedSources(): WorkspaceConfigSources {
        return {
            skillDirs: [
                { path: fwd(join(root, "injected-skills")), source: "user" },
                { path: fwd(join(root, "injected-builtin")), source: "builtin" },
            ],
            agentDirs: [],
            instructionDirs: [
                { dir: join(root, "injected-project"), label: "project-taco" },
                { dir: join(root, "injected-user"), label: "user-taco" },
                { dir: join(root, "injected-claude"), label: "user-claude" },
            ],
        };
    }

    it("preserves all existing paths, source tags and their distinct priority orders", async () => {
        const { resolveWorkspaceConfigSources } = await import(
            "../../src/config/workspaceConfigSources.ts"
        );
        const sources = resolveWorkspaceConfigSources(cwd);
        const expectedSkills: SkillDirInput[] = [
            { path: fwd(resolve(cwd, ".taco", "skills")), source: "user", scope: "workspace" },
            { path: fwd(resolve(tacoHome, "skills")), source: "user", scope: "global" },
            { path: fwd(resolve(homedir(), ".claude", "skills")), source: "user" },
            { path: fwd(resolve(homedir(), ".pi", "skills")), source: "user" },
            { path: fwd(resolve(resourceRoot(), "skills", "builtin")), source: "builtin" },
        ];
        assert.deepEqual(sources.skillDirs, expectedSkills);
        assert.deepEqual(sources.agentDirs, [
            resolve(homedir(), ".claude", "agents"),
            resolve(homedir(), ".pi", "agents"),
            resolve(tacoHome, "agents"),
            resolve(cwd, ".taco", "agents"),
        ]);
        assert.deepEqual(sources.instructionDirs, [
            { dir: resolve(cwd, ".taco"), label: "project-taco" },
            { dir: cwd, label: "project" },
            { dir: tacoHome, label: "user-taco" },
            { dir: resolve(homedir(), ".claude"), label: "user-claude" },
        ]);
    });

    it("resolves environment changes on every call without sharing mutable arrays", async () => {
        const { resolveWorkspaceConfigSources } = await import(
            "../../src/config/workspaceConfigSources.ts"
        );
        const first = resolveWorkspaceConfigSources(cwd);
        const before = structuredClone(first);
        process.env.TACO_HOME = join(root, "next-taco");
        process.env.TACO_SIDECAR_RESOURCES = join(root, "next-resources");
        const second = resolveWorkspaceConfigSources(cwd);
        assert.equal(second.skillDirs[1].path, fwd(resolve(root, "next-taco", "skills")));
        assert.equal(
            second.skillDirs[4].path,
            fwd(resolve(root, "next-resources", "skills", "builtin")),
        );
        assert.equal(second.agentDirs[2], resolve(root, "next-taco", "agents"));
        assert.equal(second.instructionDirs[2].dir, resolve(root, "next-taco"));
        second.skillDirs.pop();
        second.agentDirs.pop();
        assert.deepEqual(first, before);
        assert.equal(resolveWorkspaceConfigSources(cwd).skillDirs.length, 5);
    });

    it("keeps default instructions precedence and source labels for actual files", async () => {
        const { resolveWorkspaceConfigSources } = await import(
            "../../src/config/workspaceConfigSources.ts"
        );
        const sources = resolveWorkspaceConfigSources(cwd);
        for (const { dir, label } of sources.instructionDirs) write(dir, "CLAUDE.md", label);
        write(cwd, "AGENTS.md", "project agents");
        write(tacoHome, "AGENTS.md", "user agents");
        write(tacoHome, "DESIGN.md", "user design");
        const config = { files: { designMd: true } };
        for (const { dir, label } of sources.instructionDirs) {
            const implicit = resolveInstructions({ cwd, config });
            assert.deepEqual(resolveInstructions({ cwd, config, sources }), implicit);
            assert.deepEqual(implicit.blocks[0], {
                name: "CLAUDE.md",
                source: label,
                content: label,
            });
            assert.deepEqual(implicit.blocks.slice(1), [
                { name: "AGENTS.md", source: "project", content: "project agents" },
                { name: "DESIGN.md", source: "user-taco", content: "user design" },
            ]);
            write(dir, "CLAUDE.md", " \n ");
        }
        assert.equal(resolveInstructions({ cwd, config }).blocks.length, 2);
    });

    it("reads only injected instruction directories and re-reads changed content", () => {
        const sources = injectedSources();
        write(cwd, "CLAUDE.md", "default must not win");
        const dir = sources.instructionDirs[0].dir;
        write(dir, "CLAUDE.md", "injected first");
        write(sources.instructionDirs[1].dir, "CLAUDE.md", "injected fallback");
        assert.deepEqual(resolveInstructions({ cwd, sources }).blocks, [
            { name: "CLAUDE.md", source: "project-taco", content: "injected first" },
        ]);
        write(dir, "CLAUDE.md", " \n ");
        assert.deepEqual(resolveInstructions({ cwd, sources }).blocks, [
            { name: "CLAUDE.md", source: "user-taco", content: "injected fallback" },
        ]);
    });

    it("falls back from a worktree .taco directory to the project .taco directory", async () => {
        const { resolveWorkspaceConfigSources } = await import(
            "../../src/config/workspaceConfigSources.ts"
        );
        const projectRoot = join(root, "project-root");
        const worktree = join(projectRoot, ".taco", "worktrees", "feature");
        mkdirSync(worktree, { recursive: true });
        const sources = resolveWorkspaceConfigSources(worktree, projectRoot);
        assert.deepEqual(
            sources.skillDirs.slice(0, 2).map((entry) => entry.path),
            [fwd(join(worktree, ".taco", "skills")), fwd(join(projectRoot, ".taco", "skills"))],
        );
        assert.deepEqual(sources.instructionDirs.slice(0, 4), [
            { dir: join(worktree, ".taco"), label: "project-taco" },
            { dir: join(worktree), label: "project" },
            { dir: join(projectRoot, ".taco"), label: "project-taco" },
            { dir: join(projectRoot), label: "project" },
        ]);
        assert.equal(sources.agentDirs.at(-1), join(worktree, ".taco", "agents"));
        assert.equal(sources.agentDirs.at(-2), join(projectRoot, ".taco", "agents"));
    });

    it("falls back through real worktree instructions and rereads changed content", async () => {
        const { resolveWorkspaceConfigSources } = await import(
            "../../src/config/workspaceConfigSources.ts"
        );
        const main = join(root, "main");
        const sources = resolveWorkspaceConfigSources(cwd, main);
        const layers = [join(cwd, ".taco"), cwd, join(main, ".taco"), main, tacoHome];
        for (const [index, dir] of layers.entries()) write(dir, "CLAUDE.md", `layer ${index}`);
        for (const [index, dir] of layers.entries()) {
            assert.equal(resolveInstructions({ cwd, sources }).blocks[0].content, `layer ${index}`);
            write(dir, "CLAUDE.md", `updated ${index}`);
            assert.equal(
                resolveInstructions({ cwd, sources }).blocks[0].content,
                `updated ${index}`,
            );
            rmSync(join(dir, "CLAUDE.md"));
        }
    });

    it("loads worktree skills first and agents last, with main and global fallback", async () => {
        const { resolveWorkspaceConfigSources } = await import(
            "../../src/config/workspaceConfigSources.ts"
        );
        const main = join(root, "main");
        const sources = resolveWorkspaceConfigSources(cwd, main);
        const layers = [join(cwd, ".taco"), join(main, ".taco"), tacoHome];
        for (const [index, dir] of layers.entries()) {
            writeSkill(join(dir, "skills"), "shared", `layer ${index}`);
            write(
                join(dir, "agents"),
                "shared.md",
                `---\nname: shared\ndescription: layer ${index}\n---\nBody`,
            );
        }
        for (const [index, dir] of layers.entries()) {
            for (const scope of [undefined, "workspace"] as const) {
                if (scope === "workspace" && index === 2) continue;
                const skills = await loadSkillCatalog(cwd, [], scope, sources);
                assert.equal(
                    skills.skills.find((skill) => skill.name === "shared")?.description,
                    `layer ${index}`,
                );
            }
            const agents = await loadAgents({
                builtinDir: join(resources, "agents"),
                userDirs: sources.agentDirs,
            });
            assert.equal(
                agents.find((agent) => agent.agentType === "shared")?.description,
                `layer ${index}`,
            );
            rmSync(join(dir, "skills"), { recursive: true });
            rmSync(join(dir, "agents"), { recursive: true });
        }
    });

    it("excludes user-claude from AGENTS.md and DESIGN.md even when injected first", () => {
        const sources = injectedSources();
        sources.instructionDirs = [...sources.instructionDirs].reverse();
        for (const name of ["CLAUDE.md", "AGENTS.md", "DESIGN.md"]) {
            write(sources.instructionDirs[0].dir, name, "claude only");
        }
        write(sources.instructionDirs[1].dir, "AGENTS.md", "user agents");
        const config = { files: { designMd: true } };
        assert.deepEqual(resolveInstructions({ cwd, config, sources }).blocks, [
            { name: "CLAUDE.md", source: "user-claude", content: "claude only" },
            { name: "AGENTS.md", source: "user-taco", content: "user agents" },
        ]);
    });

    it("preserves override and read-error behavior with injected instructions", () => {
        const sources = injectedSources();
        write(sources.instructionDirs[0].dir, "AGENTS.md", "injected agents");
        mkdirSync(join(sources.instructionDirs[0].dir, "CLAUDE.md"));
        const out = resolveInstructions({ cwd, sources });
        assert.deepEqual(out.blocks, [
            { name: "AGENTS.md", source: "project-taco", content: "injected agents" },
        ]);
        assert.equal(out.errors.length, 1);
        assert.match(out.errors[0].message, /project-taco:.*EISDIR/);
        write(root, "override.md", "explicit override");
        const overridden = resolveInstructions({
            cwd,
            sources,
            config: { filesOverride: { claudeMd: join(root, "override.md") } },
        });
        assert.deepEqual(overridden.blocks[0], {
            name: "CLAUDE.md",
            source: "override",
            content: "explicit override",
        });
        assert.deepEqual(overridden.errors, []);
    });

    it("loads injected skills with source tags, first-wins priority and extension directories", async () => {
        const sources = injectedSources();
        const before = structuredClone(sources);
        writeSkill(join(cwd, ".taco", "skills"), "default-only", "Must be excluded");
        writeSkill(sources.skillDirs[0].path, "shared", "Injected user wins");
        writeSkill(sources.skillDirs[1].path, "shared", "Shadowed builtin");
        writeSkill(sources.skillDirs[1].path, "builtin-only", "Injected builtin");
        const extensionDir = join(resources, "extension-skills");
        writeSkill(extensionDir, "shared", "Shadowed extension");
        writeSkill(extensionDir, "extension-only", "Extension builtin");
        const result = await loadSkillCatalog(cwd, ["extension-skills"], undefined, sources);
        assert.deepEqual(
            result.skills.map(({ name, source, description }) => ({ name, source, description })),
            [
                { name: "shared", source: "user", description: "Injected user wins" },
                { name: "builtin-only", source: "builtin", description: "Injected builtin" },
                { name: "extension-only", source: "builtin", description: "Extension builtin" },
            ],
        );
        assert.deepEqual(sources, before);
    });

    it("keeps implicit catalog loading and existing scope selection compatible", async () => {
        const { resolveWorkspaceConfigSources } = await import(
            "../../src/config/workspaceConfigSources.ts"
        );
        writeSkill(join(cwd, ".taco", "skills"), "shared", "Project wins");
        writeSkill(join(tacoHome, "skills"), "shared", "Global definition");
        writeSkill(join(resources, "skills", "builtin"), "builtin-only", "Builtin definition");
        const sources = resolveWorkspaceConfigSources(cwd);
        for (const scope of [undefined, "workspace", "global", "builtin"] as const) {
            assert.deepEqual(
                await loadSkillCatalog(cwd, [], scope, sources),
                await loadSkillCatalog(cwd, [], scope),
            );
        }
    });

    it("renders skill authoring locations from injected sources in order", () => {
        const sources = injectedSources();
        sources.skillDirs.splice(1, 0, { path: fwd(join(root, "second-user")), source: "user" });
        const before = structuredClone(sources);
        const guidance = formatSkillAuthoringGuidance(cwd, sources);
        assert.ok(
            guidance.includes(
                `  1. ${sources.skillDirs[0].path}\n  2. ${sources.skillDirs[1].path}`,
            ),
        );
        assert.ok(guidance.includes(`Do not write to ${sources.skillDirs[2].path}`));
        assert.ok(!guidance.includes(fwd(join(cwd, ".taco", "skills"))));
        assert.deepEqual(sources, before);
    });

    it("keeps the one-argument authoring guidance API compatible", async () => {
        const { resolveWorkspaceConfigSources } = await import(
            "../../src/config/workspaceConfigSources.ts"
        );
        assert.equal(
            formatSkillAuthoringGuidance(cwd),
            formatSkillAuthoringGuidance(cwd, resolveWorkspaceConfigSources(cwd)),
        );
    });
});
