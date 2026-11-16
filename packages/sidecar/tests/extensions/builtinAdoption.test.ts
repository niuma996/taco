import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { activateExtensions } from "../../src/extensions/activation.ts";
import { manifest as gitManifest } from "../../src/extensions/builtin/gitContext/index.ts";
import { manifest as officeManifest } from "../../src/extensions/builtin/officeCli/index.ts";
import { manifest as redactionManifest } from "../../src/extensions/builtin/outputRedaction/index.ts";
import { manifest as projectManifest } from "../../src/extensions/builtin/projectManifests/index.ts";
import type { BuiltinManifest } from "../../src/extensions/builtinContract.ts";
import { ExtensionRegistry, registerBuiltinExtensions } from "../../src/extensions/registry.ts";
import { toToolCallPush } from "../../src/server/push.ts";

const dirs: string[] = [];
function temp(): string {
    const dir = mkdtempSync(join(tmpdir(), "taco-builtin-adoption-"));
    dirs.push(dir);
    return dir;
}
async function load(manifest: BuiltinManifest, config: Record<string, unknown> = {}) {
    const registry = new ExtensionRegistry();
    await registerBuiltinExtensions(registry, new Set(), [manifest], { [manifest.name]: config });
    return registry;
}
function git(cwd: string, ...args: string[]) {
    execFileSync("git", args, { cwd, stdio: "ignore" });
}
async function context(set: Awaited<ReturnType<typeof activateExtensions>>) {
    let messages: never[] = [];
    for (const hook of set.contextHooks().builtins) {
        const result = await hook({ messages });
        messages = (result?.messages ?? messages) as never[];
    }
    return JSON.stringify(messages);
}

describe("builtin adoption", () => {
    afterEach(() => {
        for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    it("validates builtin config before registering and isolates invalid values", async () => {
        const registry = new ExtensionRegistry();
        await registerBuiltinExtensions(registry, new Set(), [gitManifest, officeManifest], {
            [gitManifest.name]: { commitLimit: -1 },
        });
        assert.ok(registry.report.failed.some((e) => e.name === gitManifest.name));
        assert.ok(registry.report.loaded.some((e) => e.name === officeManifest.name));
        assert.equal(
            registry.workspaceActivators().some((e) => e.extName === gitManifest.name),
            false,
        );
    });

    it("injects deeply frozen builtin configuration into workspace and session scopes", async () => {
        const seen: unknown[] = [];
        const manifest: BuiltinManifest = {
            name: "test-builtin",
            version: "1",
            configSchema: { type: "object" },
            register: (api) => {
                assert.ok(Object.isFrozen(api.config));
                assert.ok(Object.isFrozen(api.config.nested));
                api.addSessionActivator("builtin", "test-builtin", (ctx) => {
                    seen.push(ctx.config);
                    return {
                        runEndHooks: [
                            (event) => {
                                assert.equal(event.config, ctx.config);
                            },
                        ],
                    };
                });
            },
            activator: () => (ctx) => {
                seen.push(ctx.config);
                return {};
            },
        };
        const registry = await load(manifest, { nested: { value: 42 } });
        const set = await activateExtensions(registry, { cwd: temp() });
        const session = await set.activateSession({
            cwd: temp(),
            sessionId: "x",
            sessionKind: "main",
            isIm: false,
            config: {},
        });
        session.notifyRunEnd("completed");
        await session.dispose();
        assert.equal(seen.length, 2);
        assert.deepEqual(seen[0], { nested: { value: 42 } });
        assert.equal(seen[0], seen[1]);
    });

    it("recognizes git init after workspace opening and handles an unborn branch", async () => {
        const cwd = temp();
        const set = await activateExtensions(await load(gitManifest), { cwd });
        assert.ok(!(await context(set)).includes("working_tree_changes"));
        git(cwd, "init", "--initial-branch=main");
        writeFileSync(join(cwd, "new-file.txt"), "new");
        assert.match(await context(set), /new-file.txt/);
    });

    it("honors Git injection switches and file limits", async () => {
        const cwd = temp();
        git(cwd, "init", "--initial-branch=main");
        for (const name of ["a.txt", "b.txt", "c.txt"]) writeFileSync(join(cwd, name), "new");
        const set = await activateExtensions(
            await load(gitManifest, { includeCommits: false, fileLimit: 1 }),
            { cwd },
        );
        const text = await context(set);
        assert.match(text, /a.txt/);
        assert.ok(!text.includes("b.txt"));
        assert.match(text, /2 more/);
        assert.ok(!text.includes("recent_git_commits"));
    });

    it("refreshes added and removed manifests in the same workspace", async () => {
        const cwd = temp();
        const set = await activateExtensions(await load(projectManifest), { cwd });
        assert.ok(!(await context(set)).includes("project_manifests"));
        writeFileSync(join(cwd, "Cargo.toml"), "[package]\n");
        assert.match(await context(set), /Cargo.toml/);
        rmSync(join(cwd, "Cargo.toml"));
        assert.ok(!(await context(set)).includes("project_manifests"));
    });

    it("allows the bundled OfficeCLI skill without auto-approval", async () => {
        const registry = await load(officeManifest, { autoApprove: false });
        const set = await activateExtensions(registry, { cwd: temp() });
        assert.equal(registry.extensionSkillDirs().length, 1);
        assert.deepEqual(set.commandPermissionRules(), []);
    });

    it("allows OfficeCLI auto-approval without the bundled skill", async () => {
        const registry = await load(officeManifest, { bundledSkill: false });
        const set = await activateExtensions(registry, { cwd: temp() });
        assert.equal(registry.extensionSkillDirs().length, 0);
        assert.deepEqual(set.commandPermissionRules(), ["officecli *"]);
    });
    it("reports workspace activation independently and refreshes conditional state", async () => {
        const registry = new ExtensionRegistry();
        await registerBuiltinExtensions(registry, new Set(), [
            gitManifest,
            projectManifest,
            officeManifest,
        ]);
        const cwd = temp();
        const workspace = await activateExtensions(registry, { cwd });
        const before = await workspace.activationReport();
        assert.equal(before.find((e) => e.name === gitManifest.name)?.state, "inactive");
        assert.equal(before.find((e) => e.name === gitManifest.name)?.reason, "notGitRepository");
        assert.equal(
            before.find((e) => e.name === projectManifest.name)?.reason,
            "noProjectManifests",
        );
        assert.deepEqual(
            before.find((e) => e.name === officeManifest.name)?.contributions
                .commandPermissionRules,
            ["officecli *"],
        );
        git(cwd, "init", "--initial-branch=main");
        writeFileSync(join(cwd, "Cargo.toml"), "[package]\n");
        const after = await workspace.activationReport();
        assert.equal(after.find((e) => e.name === gitManifest.name)?.state, "active");
        assert.equal(
            after.find((e) => e.name === projectManifest.name)?.contributions.contextHooks,
            1,
        );
        assert.equal(before.find((e) => e.name === gitManifest.name)?.state, "inactive");
        const other = await activateExtensions(registry, { cwd: temp(), isIm: true });
        assert.equal(
            (await other.activationReport()).find((e) => e.name === gitManifest.name)?.reason,
            "imWorkspace",
        );
    });

    it("respects the Git commit limit independently from working tree injection", async () => {
        const cwd = temp();
        git(cwd, "init", "--initial-branch=main");
        git(cwd, "config", "user.email", "test@example.com");
        git(cwd, "config", "user.name", "Test");
        for (const name of ["first", "second"]) {
            writeFileSync(join(cwd, name), name);
            git(cwd, "add", name);
            git(cwd, "commit", "-m", name);
        }
        writeFileSync(join(cwd, "untracked"), "new");
        const set = await activateExtensions(
            await load(gitManifest, { commitLimit: 1, includeWorkingTree: false }),
            { cwd },
        );
        const text = await context(set);
        assert.match(text, /second/);
        assert.ok(!text.includes("first"));
        assert.ok(!text.includes("working_tree_changes"));
    });
    it("keeps core tool-argument redaction when the model result plugin is disabled", async () => {
        const registry = new ExtensionRegistry();
        await registerBuiltinExtensions(registry, new Set([redactionManifest.name]), [
            redactionManifest,
        ]);
        assert.equal(registry.toolResultHooks().builtins.length, 0);
        const secret = "sk-proj-" + "x".repeat(40);
        const frame = toToolCallPush({
            type: "tool_start",
            toolCallId: "x",
            toolName: "bash",
            args: { command: secret },
        });
        assert.ok(frame);
        assert.ok(!JSON.stringify(frame).includes(secret));
        assert.match(JSON.stringify(frame), /REDACTED/);
        const enabled = await load(redactionManifest);
        const patch = await enabled.toolResultHooks().builtins[0]?.({
            type: "tool_result",
            input: {},
            details: undefined,
            toolName: "bash",
            toolCallId: "x",
            content: [{ type: "text", text: secret }],
            isError: false,
        });
        assert.ok(patch?.content);
        assert.ok(!JSON.stringify(patch).includes(secret));
    });
});

it("isolates diagnostic probe failures and preserves other extensions", async () => {
    const registry = new ExtensionRegistry();
    registry.addWorkspaceActivator("external", "broken", () => ({
        contextHooks: [async () => undefined],
        activationStatus: () => {
            throw new Error("probe failed");
        },
    }));
    registry.addWorkspaceActivator("external", "healthy", () => ({
        commandPermissionRules: ["example *"],
    }));
    const set = await activateExtensions(registry, { cwd: "/tmp" });
    const result = await set.activationReport();
    assert.equal(result.find((entry) => entry.name === "broken")?.state, "failed");
    assert.equal(result.find((entry) => entry.name === "broken")?.reason, "probe failed");
    assert.equal(result.find((entry) => entry.name === "healthy")?.state, "active");
});

it("rolls back skill registration summaries after a failed builtin factory", async () => {
    const registry = new ExtensionRegistry();
    registry.addExtensionSkillDirs(["old/skills"], "test-builtin");
    await registerBuiltinExtensions(registry, new Set(), [
        {
            name: "test-builtin",
            version: "1",
            register: () => {
                registry.addExtensionSkillDirs(["partial/skills"], "test-builtin");
                throw new Error("factory failed");
            },
        },
    ]);
    registry.recordLoaded({
        name: "test-builtin",
        version: "1",
        source: "builtin",
        permissions: [],
    });
    assert.deepEqual(registry.extensionSkillDirs(), ["old/skills"]);
    assert.deepEqual(registry.report.loaded[0]?.contributions.skillDirs, ["old/skills"]);
});
