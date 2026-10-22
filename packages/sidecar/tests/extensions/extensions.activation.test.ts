import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { extensionSkillDirInputs } from "../../src/config/config.ts";
import { activateExtensions, WorkspaceExtensionSet } from "../../src/extensions/activation.ts";
import {
    buildGitContextActivator,
    buildGitContextHook,
    getRecentGitCommitsTagSpec,
    getWorkingTreeChangesTagSpec,
    readUncommittedFiles,
} from "../../src/extensions/builtin/gitContext/index.ts";
import { BUILTIN_EXTENSIONS } from "../../src/extensions/builtin/manifest.ts";
import { manifest as officeCliManifest } from "../../src/extensions/builtin/officeCli/index.ts";
import {
    buildProjectManifestsActivator,
    buildProjectManifestsHook,
    getProjectManifestsTagSpec,
} from "../../src/extensions/builtin/projectManifests/index.ts";
import { createExtensionApi } from "../../src/extensions/extensionApi.ts";
import { ExtensionRegistry, registerBuiltinExtensions } from "../../src/extensions/registry.ts";
import type { ContextEvent } from "../../src/extensions/types.ts";
import { harnessContext } from "../../src/lib/harnessContext.ts";
import { evaluateCommand } from "../../src/permissions/commandPolicy.ts";
import { SlashNormalizedExecutionEnv } from "../../src/runtime/harness/slashNormalizedEnv.ts";
import type { Skill } from "../../src/runtime/pi/types.ts";
import { loadSourcedSkills } from "../../src/runtime/pi/values.ts";
import {
    parseYamlFrontmatter,
    preloadSkillFrontmatter,
    readSkillFrontmatter,
} from "../../src/skills/skillFrontmatter.ts";
import type { TacoSkill } from "../../src/skills/tacoSkill.ts";
import type { TacoTool } from "../../src/tools/index.ts";

describe("activation", () => {
    let gitDir: string;
    let nonGitDir: string;
    let registry: ExtensionRegistry;

    before(async () => {
        nonGitDir = mkdtempSync(join(tmpdir(), "taco-act-nongit-"));
        gitDir = mkdtempSync(join(tmpdir(), "taco-act-git-"));
        execFileSync("git", ["init", "--initial-branch=main"], { cwd: gitDir, stdio: "ignore" });
        execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: gitDir });
        execFileSync("git", ["config", "user.name", "Test"], { cwd: gitDir });
        writeFileSync(join(gitDir, "README.md"), "hello");
        execFileSync("git", ["add", "README.md"], { cwd: gitDir });
        execFileSync("git", ["commit", "-m", "first commit"], { cwd: gitDir });

        // Shared registry with all builtins pre-registered. Used by the "core contract"
        // describe block. Each test can still call activateExtensions independently —
        // the set is a fresh snapshot each time.
        registry = new ExtensionRegistry();
        await registerBuiltinExtensions(registry, new Set(), BUILTIN_EXTENSIONS);
    });

    after(() => {
        rmSync(nonGitDir, { recursive: true, force: true });
        rmSync(gitDir, { recursive: true, force: true });
    });

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

    const silentLogger = {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
    };

    describe("activateExtensions — core contract", () => {
        it("returns an empty set when registry is undefined", async () => {
            const set = await activateExtensions(undefined, { cwd: "/tmp" });
            assert.equal(set.toolsWithSource().length, 0);
            assert.equal(set.systemPromptContributors().length, 0);
            assert.equal(set.contextHooks().builtins.length, 0);
        });

        it("builtin git-context activator is skipped on a non-git workspace", async () => {
            const set = await activateExtensions(registry, { cwd: nonGitDir });
            assert.equal(set.contextHooks().builtins.length, 0);
            assert.equal(set.systemPromptContributors().length, 0);
        });

        it("builtin git-context activator contributes on a git workspace", async () => {
            const set = await activateExtensions(registry, { cwd: gitDir });
            // git-context contributes contextHooks (no systemPrompt — guidance is inlined in the tag).
            assert.equal(set.contextHooks().builtins.length, 1);
            assert.equal(set.systemPromptContributors().length, 0);
        });

        it("two workspaces with different git status do not pollute each other", async () => {
            const [setA, setB] = await Promise.all([
                activateExtensions(registry, { cwd: gitDir }),
                activateExtensions(registry, { cwd: nonGitDir }),
            ]);
            assert.equal(setA.contextHooks().builtins.length, 1);
            assert.equal(setB.contextHooks().builtins.length, 0);
        });

        it("process-level builtin tool_result hooks reach the workspace set", async () => {
            const set = await activateExtensions(registry, { cwd: nonGitDir });
            assert.ok(
                set.toolResultHooks().builtins.length > 0,
                "output-redaction builtin hook should be merged into the workspace set",
            );
        });
    });

    describe("activateExtensions — disabled extension", () => {
        it("disabled builtin-git-context produces zero git-context contribution", async () => {
            const registry = new ExtensionRegistry();
            const disabled = new Set(["@taco/builtin-git-context"]);
            await registerBuiltinExtensions(registry, disabled, BUILTIN_EXTENSIONS);
            const set = await activateExtensions(registry, { cwd: gitDir });
            assert.equal(set.contextHooks().builtins.length, 0);
            assert.equal(set.systemPromptContributors().length, 0);
        });
    });

    describe("activateExtensions — failure isolation", () => {
        it("a throwing workspace activator does not prevent other activators from running", async () => {
            const registry = new ExtensionRegistry();

            const badApi = createExtensionApi(
                { name: "bad-ext", version: "0.0.1", apiVersion: "1", permissions: ["tools"] },
                registry,
                silentLogger,
            );
            badApi.registerTool(fakeTool("bad-tool"));

            // Manually inject a throwing activator after the fact.
            registry.addWorkspaceActivator("external", "throws-once", async () => {
                throw new Error("deliberate test error");
            });

            // Should not throw — failures are isolated.
            const set = await activateExtensions(registry, { cwd: nonGitDir });

            // The good activator's tool should still be present.
            // toolsWithSource() entries are keyed by extension name.
            const extNames = set.toolsWithSource().map((e) => e.name);
            assert.ok(
                extNames.includes("bad-ext"),
                `expected bad-ext, got: ${JSON.stringify(extNames)}`,
            );
        });
    });

    describe("activateExtensions — ordering", () => {
        it("builtin activator systemPrompt contribution appears before process-level external contributors", async () => {
            // Note: git-context builtin no longer contributes to systemPrompt
            // (its guidance is inlined inside the context hook tag). This test
            // verifies the ordering contract using a different builtin activator
            // that DOES contribute systemPrompt — here we simulate that by
            // directly registering a workspace activator with systemPrompt.
            const orderingRegistry = new ExtensionRegistry();
            await registerBuiltinExtensions(orderingRegistry, new Set(), BUILTIN_EXTENSIONS);
            const extApi = createExtensionApi(
                {
                    name: "ext-process",
                    version: "0.0.1",
                    apiVersion: "1",
                    permissions: ["systemPrompt"],
                },
                orderingRegistry,
                silentLogger,
            );
            extApi.registerSystemPrompt({ append: "PROCESS-LEVEL" });

            // Manually inject a builtin workspace activator that contributes systemPrompt,
            // verifying builtins still appear before external contributors.
            orderingRegistry.addWorkspaceActivator(
                "builtin",
                "@test/builtin-sysprompt",
                async () => ({
                    systemPrompt: { append: "BUILTIN-SYSPROMPT" },
                }),
            );

            const set = await activateExtensions(orderingRegistry, { cwd: gitDir });
            const contribs = set.systemPromptContributors();
            assert.equal(contribs.length, 2);

            // builtin activator runs first, external process-level contributor runs second.
            assert.equal(contribs[0].append, "BUILTIN-SYSPROMPT");
            assert.equal(contribs[1].append, "PROCESS-LEVEL");
        });
    });

    describe("activateExtensions — process-level external hooks", () => {
        it("external contextHook and toolCallHook registered via createExtensionApi reach the workspace set", async () => {
            const r = new ExtensionRegistry();
            const extApi = createExtensionApi(
                {
                    name: "ext-hooks",
                    version: "0.0.1",
                    apiVersion: "1",
                    permissions: ["context", "toolCall"],
                },
                r,
                silentLogger,
            );
            extApi.registerContextHook(async () => undefined);
            extApi.registerToolCallInterceptor(async () => undefined);

            const set = await activateExtensions(r, { cwd: nonGitDir });
            assert.equal(
                set.contextHooks().external.length,
                1,
                "registerContextHook contribution must reach WorkspaceExtensionSet",
            );
            assert.equal(
                set.toolCallHooks().length,
                1,
                "registerToolCallInterceptor contribution must reach WorkspaceExtensionSet",
            );
        });
    });

    describe("activateExtensions — IM/extension filter", () => {
        let manifestDir: string;

        before(() => {
            manifestDir = mkdtempSync(join(tmpdir(), "taco-act-manifest-"));
            writeFileSync(join(manifestDir, "package.json"), '{"name":"x"}\n');
        });

        after(() => {
            if (manifestDir) rmSync(manifestDir, { recursive: true, force: true });
        });

        it("project-manifests extension contributes on a local workspace with detected manifests", async () => {
            const set = await activateExtensions(registry, { cwd: manifestDir });
            // git-context (no-op, no git) + project-manifests (one hook) = at least 1
            assert.ok(
                set.contextHooks().builtins.length >= 1,
                `expected project-manifests hook to fire locally, got ${set.contextHooks().builtins.length}`,
            );
        });

        it("project-manifests activator is skipped on IM/third-party workspaces", async () => {
            const set = await activateExtensions(registry, { cwd: manifestDir, isIm: true });
            // Project-manifests and git-context both short-circuit on isIm.
            // Builtin hooks surviving in the set here can only be process-level
            // (output-redaction); there are no workspace activators for IM.
            const imHooks = set.contextHooks().builtins;
            // Sanity: project_manifests is never reached — its detector should
            // never see an IM cwd even when one has package.json.
            assert.equal(
                imHooks.length,
                0,
                `IM workspaces must not see workspace-builtin context hooks, got ${imHooks.length}`,
            );
        });

        it("git-context activator also stays skipped on IM/third-party workspaces", async () => {
            // Use the git repo so git-context WOULD contribute if not for the filter.
            const set = await activateExtensions(registry, { cwd: gitDir, isIm: true });
            assert.equal(set.contextHooks().builtins.length, 0);
        });
    });

    describe("registerBuiltinExtensions — dispatcher bookkeeping", () => {
        it("captures tags registered during manifest.register in LoadedEntry.tags", () => {
            // Reuses the shared `registry` populated once in the top-level before()
            // — tagRegistry (tags/registry.ts) is a process-wide singleton where the
            // first successful registerExtensionTag("recent_git_commits") wins, so a
            // second ExtensionRegistry calling registerBuiltinExtensions again would
            // get addExtensionTag=false here, not because tags aren't captured.
            const entry = registry.report.loaded.find(
                (e) => e.name === "@taco/builtin-git-context",
            );
            assert.ok(entry, "expected @taco/builtin-git-context in report.loaded");
            assert.ok(
                entry?.tags?.includes("recent_git_commits"),
                `expected tags to include recent_git_commits, got: ${JSON.stringify(entry?.tags)}`,
            );
        });

        it("a throwing manifest.register lands the entry in failed only, never loaded", async () => {
            const r = new ExtensionRegistry();
            const throwing = {
                name: "@taco/test-throws",
                version: "0.1.0",
                register: () => {
                    throw new Error("intentional");
                },
            };
            await registerBuiltinExtensions(r, new Set(), [throwing]);
            assert.equal(
                r.report.loaded.some((e) => e.name === "@taco/test-throws"),
                false,
                "a throwing builtin must not appear in report.loaded",
            );
            assert.equal(
                r.report.failed.some((e) => e.name === "@taco/test-throws"),
                true,
                "a throwing builtin must appear in report.failed",
            );
        });
    });
});

describe("gitContext", () => {
    let gitDir: string;
    let nonGitDir: string;

    /** Path used by the "path rendering" suite; part of the second commit so the
     *  whole file needs one repo instead of one per suite. */
    const deepFile = "packages/some-package/src/components/VeryLongComponentName.tsx";
    const cjkFile = "文档/说明.md";

    before(() => {
        nonGitDir = mkdtempSync(join(tmpdir(), "taco-gitctx-nongit-"));
        gitDir = mkdtempSync(join(tmpdir(), "taco-gitctx-git-"));
        execFileSync("git", ["init", "--initial-branch=main"], { cwd: gitDir, stdio: "ignore" });
        execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: gitDir });
        execFileSync("git", ["config", "user.name", "Test"], { cwd: gitDir });
        writeFileSync(join(gitDir, "README.md"), "hello");
        execFileSync("git", ["add", "README.md"], { cwd: gitDir });
        execFileSync("git", ["commit", "-m", "first commit"], { cwd: gitDir });

        // Second commit carries the long and non-ASCII paths the rendering suite
        // asserts on, so its --stat is the block that suite inspects.
        mkdirSync(join(gitDir, "packages/some-package/src/components"), { recursive: true });
        mkdirSync(join(gitDir, "文档"));
        writeFileSync(join(gitDir, deepFile), "x\n");
        writeFileSync(join(gitDir, cjkFile), "x\n");
        writeFileSync(join(gitDir, "src.ts"), "export const x = 1;\n");
        execFileSync("git", ["add", "."], { cwd: gitDir });
        execFileSync("git", ["commit", "-m", "second commit"], { cwd: gitDir });

        // Create uncommitted state in gitDir:
        //   - staged:   new file "staged.txt"
        //   - unstaged: modified "README.md" and "文档/说明.md"
        //   - untracked: new files "untracked.txt" and "新文件.txt"
        writeFileSync(join(gitDir, "staged.txt"), "staged content\n");
        execFileSync("git", ["add", "staged.txt"], { cwd: gitDir, stdio: "ignore" });
        writeFileSync(join(gitDir, "README.md"), "modified\n");
        writeFileSync(join(gitDir, cjkFile), "y\n");
        writeFileSync(join(gitDir, "untracked.txt"), "untracked content\n");
        writeFileSync(join(gitDir, "新文件.txt"), "z\n");
    });

    after(() => {
        if (nonGitDir) rmSync(nonGitDir, { recursive: true, force: true });
        if (gitDir) rmSync(gitDir, { recursive: true, force: true });
    });

    function makeMessages() {
        return [{ role: "user" as const, content: "hello", timestamp: 0 }];
    }

    describe("builtin git-context extension — tag specs", () => {
        it("registers recent_git_commits as a hidden, pin-compressed, xml-balanced tag", () => {
            const spec = getRecentGitCommitsTagSpec();
            assert.equal(spec.name, "recent_git_commits");
            assert.equal(spec.scope, "user-context");
            assert.equal(spec.compression.kind, "pin");
            assert.equal(spec.tuiVisibility, "hidden");
            assert.equal(spec.parser.kind, "xml-balanced");
            assert.ok(spec.description.length > 0);
        });

        it("registers working_tree_changes as a hidden, pin-compressed, xml-balanced tag", () => {
            const spec = getWorkingTreeChangesTagSpec();
            assert.equal(spec.name, "working_tree_changes");
            assert.equal(spec.scope, "user-context");
            assert.equal(spec.compression.kind, "pin");
            assert.equal(spec.tuiVisibility, "hidden");
            assert.equal(spec.parser.kind, "xml-balanced");
            assert.ok(spec.description.length > 0);
        });
    });

    describe("builtin git-context extension — hook", () => {
        it("returns undefined when cwd is not a git repo", async () => {
            const hook = buildGitContextHook(nonGitDir);
            const result = await hook({ messages: makeMessages() } as ContextEvent);
            assert.equal(result, undefined);
        });

        it("injects a <recent_git_commits> tag with inline guidance when cwd is a git repo", async () => {
            const hook = buildGitContextHook(gitDir);
            const original = makeMessages();
            const result = await hook({ messages: original } as ContextEvent);
            assert.ok(result?.messages, "hook should return messages");
            assert.ok(Array.isArray(result.messages));
            assert.equal(result.messages[0], original[0], "original user stays at messages[0]");
            // Commits then working-tree: commits is the penultimate message when
            // both tags fire (this fixture has uncommitted files).
            const commitsMsg =
                result.messages.length >= 3
                    ? result.messages[result.messages.length - 2]
                    : result.messages[result.messages.length - 1];
            assert.ok(commitsMsg);
            const content = (commitsMsg as { content?: unknown }).content;
            let text: string;
            if (typeof content === "string") {
                text = content;
            } else if (Array.isArray(content)) {
                text = (content[0] as { text?: string })?.text ?? "";
            } else {
                text = "";
            }
            assert.match(text, /<recent_git_commits source="workspace" n="/);
            assert.match(text, /second commit/);
            assert.match(text, /first commit/);
            assert.match(text, /README\.md|src\.ts/);
            // Guidance lives inside the tag so it is never stale when new commits appear.
            assert.match(text, /reference/i);
        });

        it("injects uncommitted files (staged, unstaged, untracked) into the working_tree_changes tag", async () => {
            // gitDir has: staged.txt (staged), modified README.md (unstaged), untracked.txt (untracked)
            const hook = buildGitContextHook(gitDir);
            const result = await hook({ messages: makeMessages() } as ContextEvent);
            assert.ok(result?.messages, "hook should return messages");
            // Original user stays at [0]; tags append at the tail.
            assert.equal(result.messages.length >= 3, true, "expected original + 2 git tags");
            const first = result.messages[result.messages.length - 2];
            const second = result.messages[result.messages.length - 1];
            const firstContent = (first as { content?: unknown }).content;
            const secondContent = (second as { content?: unknown }).content;
            const firstText =
                typeof firstContent === "string"
                    ? firstContent
                    : ((firstContent as Array<{ text?: string }>)[0]?.text ?? "");
            const secondText =
                typeof secondContent === "string"
                    ? secondContent
                    : ((secondContent as Array<{ text?: string }>)[0]?.text ?? "");

            // First tag is recent_git_commits
            assert.match(firstText, /^<recent_git_commits source="workspace" n="/);
            // Second tag is working_tree_changes
            assert.match(secondText, /^<working_tree_changes source="workspace">/);
            assert.match(secondText, /staged\.txt/);
            assert.match(secondText, /untracked\.txt/);
        });

        it("re-injects the tags on every call, including when git state is unchanged", async () => {
            // The tags are a per-request overlay, not history — a hook that skips
            // an unchanged push leaves the model with no git context on every
            // later turn. One hook instance serves the main session and all
            // subagents, so a shared "last pushed" cache starved whichever session
            // did not build context first.
            const hook = buildGitContextHook(gitDir);
            const first = await hook({ messages: makeMessages() } as ContextEvent);
            const second = await hook({ messages: makeMessages() } as ContextEvent);

            assert.ok(first?.messages, "first call should return messages");
            assert.ok(second?.messages, "second call should return messages");
            for (const [label, messages] of [
                ["first", first.messages],
                ["second", second.messages],
            ] as const) {
                const texts = messages.map((m) => {
                    const content = (m as { content?: unknown }).content;
                    return typeof content === "string"
                        ? content
                        : ((content as Array<{ text?: string }>)[0]?.text ?? "");
                });
                assert.ok(
                    texts.some((t) => t.startsWith("<recent_git_commits")),
                    `${label} call should carry <recent_git_commits>`,
                );
                assert.ok(
                    texts.some((t) => t.startsWith("<working_tree_changes")),
                    `${label} call should carry <working_tree_changes>`,
                );
            }
        });
    });

    describe("builtin git-context extension — uncommitted files", () => {
        it("readUncommittedFiles returns staged, unstaged, and untracked items", async () => {
            const files = await readUncommittedFiles(gitDir);
            // gitDir setup: staged.txt (A), README.md (M), untracked.txt (??)
            assert.ok(files.staged.some((s) => s.includes("staged.txt")));
            assert.ok(files.unstaged.some((s) => s.includes("README.md")));
            assert.ok(files.untracked.some((s) => s.includes("untracked.txt")));
        });

        it("readUncommittedFiles returns empty arrays on a non-git directory", async () => {
            const files = await readUncommittedFiles(nonGitDir);
            // Errors are swallowed; all three arrays fall back to [].
            assert.equal(files.staged.length, 0);
            assert.equal(files.unstaged.length, 0);
            assert.equal(files.untracked.length, 0);
        });
    });

    describe("builtin git-context extension — path rendering", () => {
        it("renders full, unescaped paths in the commit stat with a single summary line", async () => {
            const hook = buildGitContextHook(gitDir);
            const result = await hook({ messages: makeMessages() } as ContextEvent);
            const text = (result?.messages ?? [])
                .map((m) => (m as { content?: unknown }).content)
                .map((c) =>
                    typeof c === "string" ? c : ((c as Array<{ text?: string }>)[0]?.text ?? ""),
                )
                .find((t) => t.startsWith("<recent_git_commits"));
            assert.ok(text, "expected a <recent_git_commits> tag");
            assert.ok(text.includes(deepFile), "long path must not be elided");
            assert.ok(text.includes(cjkFile), "non-ASCII path must not be octal-escaped");
            // One summary line per commit — check the newest (second) commit's
            // block, since the fixture now holds two commits.
            const newest = text.split("\n\n• ")[1] ?? text;
            assert.equal(
                newest.match(/files? changed/g)?.length,
                1,
                "summary line must appear once",
            );
        });

        it("readUncommittedFiles returns unescaped non-ASCII paths", async () => {
            const files = await readUncommittedFiles(gitDir);
            assert.ok(files.unstaged.some((s) => s.includes(cjkFile)));
            assert.ok(files.untracked.includes("新文件.txt"));
        });
    });

    describe("builtin git-context extension — activator", () => {
        it("returns undefined when cwd is not a git repo", async () => {
            const activator = buildGitContextActivator();
            const result = await activator({ cwd: nonGitDir });
            assert.equal(result, undefined);
        });

        it("returns {contextHooks} (no systemPrompt) when cwd is a git repo", async () => {
            const activator = buildGitContextActivator();
            const result = await activator({ cwd: gitDir });
            assert.ok(result, "activator should return a contribution");
            assert.ok(result.contextHooks && result.contextHooks.length > 0);
            assert.equal(result.contextHooks.length, 1);
            // Guidance lives inside the context hook's injected tag, not in
            // systemPrompt — so systemPrompt contribution must be absent.
            assert.equal(result.systemPrompt, undefined);
        });
    });
});

describe("officeCli", () => {
    const OFFICECLI_RULE = "officecli *";
    const SKILL_DIR = "extensions/builtin/officeCli/skills";

    describe("officeCli extension — activator", () => {
        it("contributes the officecli allow-rule for any cwd", async () => {
            const activator = await officeCliManifest.activator?.();
            assert.ok(activator, "manifest must declare an activator");
            const contribution = await activator({ cwd: "/nonexistent" });
            assert.deepEqual(contribution?.commandPermissionRules, [OFFICECLI_RULE]);
        });
    });

    describe("WorkspaceExtensionSet — commandPermissionRules", () => {
        it("collects contributed rules and dedupes repeats", () => {
            const set = new WorkspaceExtensionSet();
            set.addContribution("builtin", { commandPermissionRules: [OFFICECLI_RULE] });
            set.addContribution("builtin", { commandPermissionRules: [OFFICECLI_RULE, "mmx *"] });
            assert.deepEqual(set.commandPermissionRules(), [OFFICECLI_RULE, "mmx *"]);
        });

        it("returns an empty list when no contribution carries rules", () => {
            const set = new WorkspaceExtensionSet();
            set.addContribution("builtin", { contextHooks: [] });
            assert.deepEqual(set.commandPermissionRules(), []);
        });
    });

    describe("officeCli extension — end-to-end through the registry", () => {
        it("activation collects the rule contributed by the real builtin", async () => {
            const registry = new ExtensionRegistry();
            await registerBuiltinExtensions(registry, new Set(), [officeCliManifest]);
            const set = await activateExtensions(registry, { cwd: "/tmp" });
            assert.deepEqual(set.commandPermissionRules(), [OFFICECLI_RULE]);
        });

        it("disabling the extension drops its rule", async () => {
            const registry = new ExtensionRegistry();
            await registerBuiltinExtensions(registry, new Set([officeCliManifest.name]), [
                officeCliManifest,
            ]);
            const set = await activateExtensions(registry, { cwd: "/tmp" });
            assert.deepEqual(set.commandPermissionRules(), []);
        });
    });

    describe("officeCli extension — evaluation", () => {
        it("allows an officecli command and still asks for unrelated ones", () => {
            const config = { mode: "ask" as const, rules: [OFFICECLI_RULE] };
            assert.equal(
                evaluateCommand("officecli set deck.pptx / --prop text=hi", config).behavior,
                "allow",
            );
            assert.equal(evaluateCommand("rm -rf build", config).behavior, "ask");
        });
    });

    describe("officeCli extension — bundled skill dir", () => {
        let tmpCwd: string;

        before(() => {
            tmpCwd = mkdtempSync(join(tmpdir(), "taco-officecli-skill-"));
        });

        after(() => {
            rmSync(tmpCwd, { recursive: true, force: true });
        });

        /** Scan only the extension-declared dirs, with the extension enabled or not. */
        async function scanForSkill(disabled: ReadonlySet<string>): Promise<TacoSkill[]> {
            const registry = new ExtensionRegistry();
            await registerBuiltinExtensions(registry, disabled, [officeCliManifest]);
            const loaded = await loadSourcedSkills<TacoSkill["source"], TacoSkill>(
                new SlashNormalizedExecutionEnv({ cwd: tmpCwd }),
                extensionSkillDirInputs(registry.extensionSkillDirs()),
                (skill, source): TacoSkill => ({ ...skill, source }),
                harnessContext,
            );
            return loaded.skills.map((entry) => entry.skill).filter((s) => s.name === "officecli");
        }

        it("declares the skill dir relative to resourceRoot()", () => {
            assert.deepEqual(officeCliManifest.skillDirs, [SKILL_DIR]);
        });

        it("enabled: the bundled skill is scanned from the extension dir", async () => {
            const found = await scanForSkill(new Set());
            assert.equal(found.length, 1, "expected exactly one officecli skill");
            assert.equal(found[0]?.source, "builtin");
            assert.ok(
                found[0]?.filePath.includes(`${SKILL_DIR}/officecli/SKILL.md`),
                `filePath should resolve under the extension dir, got ${found[0]?.filePath}`,
            );
        });

        it("disabled: the bundled skill is not scanned", async () => {
            assert.deepEqual(await scanForSkill(new Set([officeCliManifest.name])), []);
        });
    });
});

describe("officecliSkill", () => {
    const HERE = dirname(fileURLToPath(import.meta.url));
    const SKILL_PATH = join(
        HERE,
        "..",
        "..",
        "src",
        "extensions",
        "builtin",
        "officeCli",
        "skills",
        "officecli",
        "SKILL.md",
    );

    function body(): string {
        return readFileSync(SKILL_PATH, "utf-8");
    }

    describe("officecli builtin skill", () => {
        it("frontmatter declares name + description with a trigger-style lead", () => {
            const fm = parseYamlFrontmatter(body());
            assert.equal(fm.name, "officecli");
            assert.ok(
                typeof fm.description === "string" && fm.description.length > 0,
                "description must be a non-empty string so the skill surfaces in the prompt",
            );
            assert.ok(
                fm.description.toLowerCase().startsWith("use when"),
                "description must lead with the trigger phrase so the model knows when to reach for it",
            );
            // Length stays under pi's 1024-char ceiling so the loader won't flag it.
            assert.ok(fm.description.length <= 1024, "description must fit pi's ceiling");
        });

        it("directory name matches the frontmatter name (pi loads SKILL.md under a directory named after the skill)", () => {
            const fm = parseYamlFrontmatter(body());
            const parentDir = SKILL_PATH.split("/").slice(-2, -1)[0];
            assert.equal(parentDir, fm.name, "parent directory must equal frontmatter name");
        });

        it("frontmatter uses no taco-private keys — drives the model via shell, not subagent dispatch", () => {
            const fm = parseYamlFrontmatter(body());
            assert.equal(
                fm.runAs,
                undefined,
                "officecli should not override runAs; the skill wraps a CLI the model shells out to, not a subagent flow",
            );
            assert.equal(
                fm.inlineOnly,
                undefined,
                "officecli should not be inlineOnly — it has no subagent-of-its-own dispatch to fence",
            );
            assert.equal(fm.allowedTools, undefined);
            assert.equal(fm.model, undefined);
        });

        it("frontmatter is parseable via the cached readSkillFrontmatter path", () => {
            const skill: Skill = {
                name: "officecli",
                description: "stub",
                filePath: SKILL_PATH,
                content: "stub",
            } as Skill;
            preloadSkillFrontmatter([skill]);
            const fm = readSkillFrontmatter(SKILL_PATH);
            assert.equal(fm.runAs, undefined);
            assert.equal(fm.inlineOnly, undefined);
        });
    });
});

describe("projectManifests", () => {
    function makeMessages() {
        return [{ role: "user" as const, content: "hello", timestamp: 0 }];
    }

    describe("builtin project-manifest extension — tag spec", () => {
        it("registers project_manifests as a hidden, pin-compressed, xml-balanced tag", () => {
            const spec = getProjectManifestsTagSpec();
            assert.equal(spec.name, "project_manifests");
            assert.equal(spec.scope, "user-context");
            assert.equal(spec.compression.kind, "pin");
            assert.equal(spec.tuiVisibility, "hidden");
            assert.equal(spec.parser.kind, "xml-balanced");
            assert.ok(spec.description.length > 0);
        });
    });

    describe("builtin project-manifest extension — activator", () => {
        let empty: string;
        let cargoOnly: string;
        let polyglot: string;
        let csprojDir: string;

        before(() => {
            empty = mkdtempSync(join(tmpdir(), "taco-pm-empty-"));
            cargoOnly = mkdtempSync(join(tmpdir(), "taco-pm-cargo-"));
            writeFileSync(join(cargoOnly, "Cargo.toml"), '[package]\nname = "x"\n');

            polyglot = mkdtempSync(join(tmpdir(), "taco-pm-polyglot-"));
            writeFileSync(join(polyglot, "package.json"), '{"name":"x"}\n');
            writeFileSync(join(polyglot, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
            writeFileSync(join(polyglot, "Cargo.toml"), '[package]\nname = "x"\n');

            csprojDir = mkdtempSync(join(tmpdir(), "taco-pm-csproj-"));
            writeFileSync(join(csprojDir, "App.csproj"), "<Project>\n</Project>\n");
            writeFileSync(join(csprojDir, "App.sln"), "Microsoft Visual Studio Solution File\n");
        });

        after(() => {
            for (const d of [empty, cargoOnly, polyglot, csprojDir]) {
                if (d) rmSync(d, { recursive: true, force: true });
            }
        });

        it("returns undefined when no manifest matches", async () => {
            const activator = buildProjectManifestsActivator();
            const result = await activator({ cwd: empty });
            assert.equal(result, undefined);
        });

        it("returns contextHooks when a single manifest matches", async () => {
            const activator = buildProjectManifestsActivator();
            const result = await activator({ cwd: cargoOnly });
            assert.ok(result, "activator must contribute when Cargo.toml is present");
            assert.ok(result?.contextHooks);
            assert.equal(result?.contextHooks.length, 1);
        });

        it("returns sorted, deduplicated filenames for a polyglot workspace", async () => {
            const activator = buildProjectManifestsActivator();
            const result = await activator({ cwd: polyglot });
            assert.ok(result?.contextHooks);
            const hook = buildProjectManifestsHook(polyglot);
            const out = await hook({ messages: makeMessages() } as ContextEvent);
            assert.ok(out, "hook must inject on polyglot workspace");
            // Pull just the bullet list — the guidance text also references
            // `package.json` as an example, which would mislead a naive indexOf.
            const text = JSON.stringify(out?.messages);
            const bullets = text.match(/- [^\n]+/g) ?? [];
            const bulletsText = bullets.join("\n");
            assert.match(bulletsText, /- Cargo\.toml/);
            assert.match(bulletsText, /- package\.json/);
            assert.match(bulletsText, /- pnpm-workspace\.yaml/);
            // Sorted alphabetically: Cargo.toml < package.json < pnpm-workspace.yaml
            const idxCargo = bulletsText.indexOf("Cargo.toml");
            const idxPkg = bulletsText.indexOf("package.json");
            const idxPnpm = bulletsText.indexOf("pnpm-workspace.yaml");
            assert.ok(
                idxCargo < idxPkg && idxPkg < idxPnpm,
                `filenames must be sorted, got: ${bulletsText}`,
            );
        });

        it("matches glob patterns for filename families", async () => {
            const activator = buildProjectManifestsActivator();
            const result = await activator({ cwd: csprojDir });
            assert.ok(result, "activator must contribute when *.csproj / *.sln match");
            const hook = buildProjectManifestsHook(csprojDir);
            const out = await hook({ messages: makeMessages() } as ContextEvent);
            const text = JSON.stringify(out?.messages);
            assert.match(text, /App\.csproj/);
            assert.match(text, /App\.sln/);
        });

        it("suppresses matches that .gitignore excludes", async () => {
            const dir = mkdtempSync(join(tmpdir(), "taco-pm-ignore-"));
            writeFileSync(join(dir, "package.json"), '{"name":"x"}\n');
            writeFileSync(join(dir, "Cargo.toml"), '[package]\nname = "x"\n');
            writeFileSync(join(dir, ".gitignore"), "Cargo.toml\n");
            try {
                const hook = buildProjectManifestsHook(dir);
                const out = await hook({ messages: makeMessages() } as ContextEvent);
                const text = JSON.stringify(out?.messages);
                assert.match(text, /package\.json/);
                assert.ok(!text.includes("Cargo.toml"), "gitignored manifest must not be reported");
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });
    });

    describe("builtin project-manifest extension — hook", () => {
        let empty: string;
        let withManifest: string;

        before(() => {
            empty = mkdtempSync(join(tmpdir(), "taco-pm-hook-empty-"));
            withManifest = mkdtempSync(join(tmpdir(), "taco-pm-hook-yes-"));
            writeFileSync(join(withManifest, "package.json"), '{"name":"x"}\n');
        });

        after(() => {
            if (empty) rmSync(empty, { recursive: true, force: true });
            if (withManifest) rmSync(withManifest, { recursive: true, force: true });
        });

        it("returns undefined when no manifest is detected", async () => {
            const hook = buildProjectManifestsHook(empty);
            const result = await hook({ messages: makeMessages() } as ContextEvent);
            assert.equal(result, undefined);
        });

        it("prepends a <project_manifests> tag with inline guidance", async () => {
            const hook = buildProjectManifestsHook(withManifest);
            const result = await hook({ messages: makeMessages() } as ContextEvent);
            assert.ok(result, "hook must inject on package.json workspace");
            const messages = result?.messages ?? [];
            assert.ok(messages.length >= 2, "tag prepended + original message");
            const first = messages[0] as { content: Array<{ text?: string }> };
            const tagText = first.content[0]?.text ?? "";
            assert.match(tagText, /<project_manifests source="workspace">/);
            assert.match(tagText, /package\.json/);
            assert.match(tagText, /Do NOT fetch the files' contents unprompted/);
        });
    });
});
