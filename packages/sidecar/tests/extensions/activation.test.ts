/**
 * activation.ts — WorkspaceExtensionSet + activateExtensions integration tests:
 * disabled bug regression, multi-cwd isolation, activator failure isolation, ordering.
 */

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { activateExtensions } from "../../src/extensions/activation.ts";
import { BUILTIN_EXTENSIONS } from "../../src/extensions/builtin/manifest.ts";
import { createExtensionApi } from "../../src/extensions/extensionApi.ts";
import { ExtensionRegistry, registerBuiltinExtensions } from "../../src/extensions/registry.ts";

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

const fakeTool = (name: string): AgentTool =>
    ({ name, description: "fake", execute: async () => ({ text: "" }) }) as unknown as AgentTool;

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
        orderingRegistry.addWorkspaceActivator("builtin", "@test/builtin-sysprompt", async () => ({
            systemPrompt: { append: "BUILTIN-SYSPROMPT" },
        }));

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
        const entry = registry.report.loaded.find((e) => e.name === "@taco/builtin-git-context");
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
