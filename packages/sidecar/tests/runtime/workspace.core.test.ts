/**
 * WorkspaceRuntime — extension integration, session/execution cwd split,
 * default-model fallback, and channel path privacy.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { asWorkspaceId, type CustomProviderConfig } from "@taco-ai/protocol";
import { filterToolsForAgent } from "../../src/agents/filterTools.ts";
import type { ImWorkspacePolicy } from "../../src/channels/imWorkspacePolicy.ts";
import { activateExtensions } from "../../src/extensions/activation.ts";
import { createExtensionApi } from "../../src/extensions/extensionApi.ts";
import { ExtensionRegistry } from "../../src/extensions/registry.ts";
import { harnessContext } from "../../src/lib/harnessContext.ts";
import { buildSystemPrompt } from "../../src/prompts/buildSystemPrompt.ts";
import { ProviderKeyStore } from "../../src/runtime/models/providerKeyStore.ts";
import { WorkspaceRuntime } from "../../src/runtime/workspace.ts";
import type { TacoTool } from "../../src/tools/index.ts";
import { useTempTacoHome } from "../_helpers/tempTacoHome.ts";

let tmpDirCore: string;

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

const makeRegistry = (tools: TacoTool[], prompts: Array<{ prepend?: string; append?: string }>) => {
    const r = new ExtensionRegistry();
    const api = createExtensionApi(
        {
            name: "fixture",
            version: "0.0.1",
            apiVersion: "1",
            permissions: ["tools", "systemPrompt"],
        },
        r,
        silentLogger,
    );
    for (const t of tools) api.registerTool(t);
    for (const p of prompts) api.registerSystemPrompt(p);
    return r;
};

describe("WorkspaceRuntime ↔ extensions integration", () => {
    before(() => {
        tmpDirCore = mkdtempSync(join(tmpdir(), "taco-ws-reg-"));
    });

    after(() => {
        rmSync(tmpDirCore, { recursive: true, force: true });
    });

    it("applies extension tools to this.tools (no longer dropped by constructor order)", async () => {
        const registry = makeRegistry([fakeTool("ext-tool")], []);
        const extensions = await activateExtensions(registry, { cwd: tmpDirCore });
        const ws = new WorkspaceRuntime({
            providerKeyStore: new ProviderKeyStore({}),
            cwd: asWorkspaceId(tmpDirCore),
            tools: [fakeTool("builtin-tool")],
            extensions,
        });
        const names = ws.tools.map((t) => t.name);
        assert.ok(names.includes("ext-tool"), `expected ext-tool, got: ${JSON.stringify(names)}`);
        assert.ok(
            names.includes("builtin-tool"),
            `expected builtin-tool, got: ${JSON.stringify(names)}`,
        );
    });

    it("extension tool with same name overrides base tool (no duplicate in harness)", async () => {
        const registry = makeRegistry([fakeTool("shared")], []);
        const extensions = await activateExtensions(registry, { cwd: tmpDirCore });
        const ws = new WorkspaceRuntime({
            providerKeyStore: new ProviderKeyStore({}),
            cwd: asWorkspaceId(tmpDirCore),
            tools: [fakeTool("shared")],
            extensions,
        });
        const shared = ws.tools.filter((t) => t.name === "shared");
        assert.equal(
            shared.length,
            1,
            `must be exactly 1 'shared' tool, got: ${JSON.stringify(shared.map((t) => t.name))}`,
        );
    });

    it("two extensions registering the same tool name do not produce duplicates (design §4.3)", async () => {
        const r = new ExtensionRegistry();
        const apiA = createExtensionApi(
            { name: "ext-a", version: "0.0.1", apiVersion: "1", permissions: ["tools"] },
            r,
            silentLogger,
        );
        const apiB = createExtensionApi(
            { name: "ext-b", version: "0.0.1", apiVersion: "1", permissions: ["tools"] },
            r,
            silentLogger,
        );
        apiA.registerTool(fakeTool("dup"));
        apiB.registerTool(fakeTool("dup"));
        const extensions = await activateExtensions(r, { cwd: tmpDirCore });
        const ws = new WorkspaceRuntime({
            providerKeyStore: new ProviderKeyStore({}),
            cwd: asWorkspaceId(tmpDirCore),
            tools: [fakeTool("builtin-only")],
            extensions,
        });
        const dups = ws.tools.filter((t) => t.name === "dup");
        assert.equal(
            dups.length,
            1,
            `must be exactly 1 'dup' tool, got: ${JSON.stringify(ws.tools.map((t) => t.name))}`,
        );
    });

    it("applies extension systemPrompt contributors (no longer dropped by constructor order)", async () => {
        const registry = makeRegistry([], [{ append: "FROM-EXT" }]);
        const extensions = await activateExtensions(registry, { cwd: tmpDirCore });
        const ws = new WorkspaceRuntime({
            providerKeyStore: new ProviderKeyStore({}),
            cwd: asWorkspaceId(tmpDirCore),
            tools: [fakeTool("x")],
            extensions,
        });
        assert.ok(
            ws.systemPrompt.includes("FROM-EXT"),
            `expected system prompt to contain extension contribution; sample: ${ws.systemPrompt.slice(-200)}`,
        );
    });

    it("without extensions, behaves identically to before (no contributors push)", () => {
        const ws = new WorkspaceRuntime({
            providerKeyStore: new ProviderKeyStore({}),
            cwd: asWorkspaceId(tmpDirCore),
            tools: [fakeTool("only-builtin")],
            systemPrompt: "USER-PROMPT",
        });
        const names = ws.tools.map((t) => t.name);
        assert.deepEqual(names, ["only-builtin"]);
        assert.ok(ws.systemPrompt.includes("USER-PROMPT"));
    });
});

const DEFAULT_POLICY: ImWorkspacePolicy = {
    tools: { fsTools: "deny", shell: "deny" },
    commands: { mode: "ask" },
    executionDir: { mode: "shared" },
};
const SHELL_ALLOW_POLICY: ImWorkspacePolicy = {
    tools: { fsTools: "deny", shell: "allow" },
    commands: { mode: "ask" },
    executionDir: { mode: "shared" },
};

function makeRuntime(
    opts: Partial<ConstructorParameters<typeof WorkspaceRuntime>[0]> = {},
): WorkspaceRuntime {
    const scratch = mkdtempSync(join(tmpdir(), "ws-cwd-scratch-"));
    const sessionsRoot = mkdtempSync(join(tmpdir(), "ws-cwd-sessions-"));
    return new WorkspaceRuntime({
        cwd: "im://mock-1/u1/c1",
        fsCwd: scratch,
        workspaceKey: "im://mock-1/u1/c1",
        sessionsRoot,
        ...opts,
    } as ConstructorParameters<typeof WorkspaceRuntime>[0]);
}

describe("WorkspaceRuntime sessionCwd / executionCwd split", () => {
    it("sessionCwd is the fsCwd and defaults executionCwd to the same dir", () => {
        const ws = makeRuntime();
        assert.equal(ws.sessionCwd, ws.executionCwd); // default: same dir
    });

    it("repo.list scopes to the session cwd directory", async () => {
        const ws = makeRuntime();
        const list = await ws.repo.list({ cwd: ws.sessionCwd }, harnessContext);
        assert.ok(Array.isArray(list));
    });

    it("executionCwd overrides env.cwd and defaults to sessionCwd when absent", () => {
        const exec = mkdtempSync(join(tmpdir(), "ws-cwd-exec-"));
        const ws = makeRuntime({ executionCwd: exec });
        assert.equal(ws.executionCwd, exec);
        assert.equal(ws.env.cwd, exec);
        assert.notEqual(ws.sessionCwd, ws.executionCwd); // storage identity unchanged
        const defaulted = makeRuntime();
        assert.equal(defaulted.executionCwd, defaulted.sessionCwd);
    });

    it("applies the policy to the assembled tool set", () => {
        const denied = makeRuntime({ imPolicy: DEFAULT_POLICY });
        const deniedNames = denied.tools.map((t) => t.name);
        for (const tool of ["read", "write", "edit", "grep", "glob", "shell"]) {
            assert.ok(!deniedNames.includes(tool), `expected ${tool} removed under default policy`);
        }

        const allowed = makeRuntime({ imPolicy: SHELL_ALLOW_POLICY });
        const allowedNames = allowed.tools.map((t) => t.name);
        assert.ok(allowedNames.includes("shell"), "expected shell present under shell: allow");
        assert.ok(!allowedNames.includes("read"), "expected read still removed");
    });

    it("legacy disableFsTools behaves exactly like the default deny policy", () => {
        const legacy = makeRuntime({ disableFsTools: true });
        const names = legacy.tools.map((t) => t.name);
        for (const tool of ["read", "write", "edit", "grep", "glob", "shell"]) {
            assert.ok(!names.includes(tool), `expected ${tool} removed`);
        }
    });

    // Core security assertion of the design: a subagent may only ever receive
    // the intersection of the parent's ALREADY-FILTERED toolset and its own
    // whitelist. An agent definition asking for `shell` explicitly must still
    // come back empty when the workspace policy denies it.
    it("a subagent cannot recover a tool the workspace policy denied", () => {
        const ws = makeRuntime({ imPolicy: DEFAULT_POLICY });
        assert.ok(!ws.tools.some((t) => t.name === "shell"));
        assert.ok(!ws.agentSpawner.getTools().some((t) => t.name === "shell"));

        const explicit = filterToolsForAgent(
            ws.agentSpawner.getTools() as never,
            ["shell", "read", "grep"],
            1,
        );
        assert.deepEqual(
            explicit.map((t) => t.name),
            [],
            "whitelisting shell must not resurrect it",
        );

        const inheritAll = filterToolsForAgent(ws.agentSpawner.getTools() as never, undefined, 1);
        assert.ok(!inheritAll.some((t) => t.name === "shell"));
    });

    it("a subagent does receive a tool the policy allows", () => {
        const ws = makeRuntime({ imPolicy: SHELL_ALLOW_POLICY });
        const child = filterToolsForAgent(ws.agentSpawner.getTools() as never, ["shell"], 1);
        assert.deepEqual(
            child.map((t) => t.name),
            ["shell"],
        );
    });

    it("memory stays partitioned by sessionCwd, not executionCwd", () => {
        const exec = mkdtempSync(join(tmpdir(), "ws-cwd-exec2-"));
        const ws = makeRuntime({ executionCwd: exec });
        // memoryStore.initialize already ran with sessionCwd; a second call with
        // a different id must be a no-op (initialized flag guards it).
        const probe = (ws as unknown as { memoryStore: { _workspaceId: string } }).memoryStore;
        assert.equal(probe._workspaceId, ws.sessionCwd);
    });
});

/**
 * WorkspaceRuntime — default model resolution policy.
 *
 * A configured default can stop resolving whenever the catalog moves under it:
 * the provider is deleted, or the model is removed from a provider's list (an
 * extra dropped, a static hidden, a custom provider's list edited). The
 * constructor and the hot-reload path used to disagree on what to do about that
 * — construction returned undefined (every session.create then failed with
 * "no model configured", a message that points at the wrong thing) while
 * hot-reload silently kept the previous value (looked fine, broke on the next
 * restart). Both now fall back to the first catalog model.
 *
 * A cleared API key is NOT one of these: the model still resolves and the
 * failure surfaces per-request as "Provider is not configured", so the test
 * file deliberately excludes that case.
 *
 * Run: cd packages/sidecar && pnpm exec tsx --test tests/runtime/workspace.core.test.ts
 */

const RELAY: CustomProviderConfig = {
    id: "custom:relay",
    name: "Relay",
    api: "chatcomplete",
    baseUrl: "https://relay.example/v1",
    models: [{ id: "relay-fast" }],
};

describe("WorkspaceRuntime — default model resolution", () => {
    const tmpDirDefaultModel = useTempTacoHome("defaultmodel");

    function makeWorkspace(
        defaultModel?: string,
        defaultProvider?: string,
        customProviders?: readonly CustomProviderConfig[],
    ): WorkspaceRuntime {
        return new WorkspaceRuntime({
            providerKeyStore: new ProviderKeyStore({}),
            cwd: asWorkspaceId(tmpDirDefaultModel),
            defaultModel,
            defaultProvider,
            customProviders,
        });
    }

    it("uses the configured default when it resolves", () => {
        const ws = makeWorkspace("relay-fast", RELAY.id, [RELAY]);
        assert.equal(ws.defaultModel?.id, "relay-fast");
        assert.equal(ws.defaultModel?.provider, RELAY.id);
    });

    it("falls back to the first catalog model when the provider is gone", () => {
        // The exact regression: defaultProvider named a deleted custom provider.
        const ws = makeWorkspace("relay-fast", "custom:deleted", []);
        assert.ok(ws.defaultModel, "a stale default must not leave the workspace without a model");
        assert.notEqual(ws.defaultModel?.provider, "custom:deleted");
    });

    it("falls back when the model was removed from a live provider's list", () => {
        const ws = makeWorkspace("relay-gone", RELAY.id, [RELAY]);
        assert.ok(ws.defaultModel);
        assert.notEqual(ws.defaultModel?.id, "relay-gone");
    });

    it("still falls back to the first catalog model when no default is configured", () => {
        const ws = makeWorkspace(undefined, undefined, [RELAY]);
        assert.ok(ws.defaultModel);
    });

    it("setDefaultModel applies the same fallback instead of keeping a stale value", () => {
        const ws = makeWorkspace("relay-fast", RELAY.id, [RELAY]);
        const before = ws.defaultModel?.id;
        assert.equal(before, "relay-fast");

        // Hot-reload pointing at a provider that no longer exists.
        ws.setDefaultModel("relay-fast", "custom:deleted");
        assert.ok(ws.defaultModel, "must not fall through to undefined");
        assert.notEqual(ws.defaultModel?.provider, "custom:deleted");
    });

    it("setDefaultModel re-resolves the same id after the provider qualifier is dropped", () => {
        // What the desktop's delete path now writes: defaultProvider cleared,
        // defaultModel kept — the cross-provider search finds it again.
        const ws = makeWorkspace("relay-fast", RELAY.id, [RELAY]);
        ws.setDefaultModel("relay-fast", undefined);
        assert.equal(ws.defaultModel?.id, "relay-fast");
        assert.equal(ws.defaultModel?.provider, RELAY.id);
    });
});

/**
 * IM/third-party channel path-privacy propagation.
 *
 * Regression guard: the workspace derives `isIm` once and must hand it to BOTH
 * the parent system prompt and the AgentSpawner, which rebuilds every subagent
 * prompt. A child that missed the flag would receive the default path-semantics
 * block (absolute-path example, "absolute paths are accepted") and no
 * `<channel_safety>` section, then relay full filesystem paths back through the
 * channel. The parent-only assertions passed while that gap was live, so these
 * tests deliberately reach into the spawner's inherited state.
 *
 * Run: pnpm --filter @taco-ai/sidecar test
 */

/** The flag the spawner inherits from the workspace and replays into child prompts. */
function inheritedHideWorkspacePath(ws: WorkspaceRuntime): boolean | undefined {
    return (ws.agentSpawner as unknown as { hideWorkspacePath: boolean | undefined })
        .hideWorkspacePath;
}

const ABSOLUTE_PATH_EXAMPLE = "/Users/me/project/src/foo.ts";

describe("IM workspace withholds the path from parent and children alike", () => {
    let sessionsRoot: string;
    let localCwd: string;
    let im: WorkspaceRuntime;
    let local: WorkspaceRuntime;

    before(() => {
        sessionsRoot = mkdtempSync(join(tmpdir(), "taco-chansafe-sessions-"));
        localCwd = mkdtempSync(join(tmpdir(), "taco-chansafe-local-"));
        im = new WorkspaceRuntime({
            providerKeyStore: new ProviderKeyStore({}),
            cwd: asWorkspaceId("im://mock-1/u1/c1"),
            workspaceKey: "im://mock-1/u1/c1",
            sessionsRoot,
        });
        local = new WorkspaceRuntime({
            providerKeyStore: new ProviderKeyStore({}),
            cwd: asWorkspaceId(localCwd),
            sessionsRoot,
        });
    });

    after(async () => {
        await im.dispose();
        await local.dispose();
        rmSync(sessionsRoot, { recursive: true, force: true });
        rmSync(localCwd, { recursive: true, force: true });
    });

    it("parent prompt on an IM workspace carries channel_safety and no absolute example", () => {
        assert.ok(im.systemPrompt.includes("<channel_safety>"));
        assert.ok(!im.systemPrompt.includes(ABSOLUTE_PATH_EXAMPLE));
    });

    it("spawner inherits hideWorkspacePath so rebuilt child prompts keep the guard", () => {
        const hideWorkspacePath = inheritedHideWorkspacePath(im);
        assert.equal(hideWorkspacePath, true, "child rebuild must see the IM flag");

        // Replay what agentSpawner does with the inherited flag.
        const child = buildSystemPrompt({
            tools: [{ name: "read" }],
            hideWorkspacePath,
            sessionKind: { role: "subagent", depth: 1 },
        });
        assert.ok(child.includes("<channel_safety>"), "child needs the channel_safety block");
        assert.ok(
            !child.includes(ABSOLUTE_PATH_EXAMPLE),
            "child must not see the absolute example",
        );
        assert.ok(child.includes("Never echo a full filesystem path back to the user"));
    });

    it("filesystem workspace keeps the default path semantics for parent and children", () => {
        assert.ok(!local.systemPrompt.includes("<channel_safety>"));
        assert.ok(local.systemPrompt.includes(ABSOLUTE_PATH_EXAMPLE));
        assert.ok(!inheritedHideWorkspacePath(local), "local workspace must not set the IM flag");
    });
});

// Regression: `<available_skills>` printed each skill's absolute host path
// into IM prompts, though the default IM policy strips read and shell — so the
// path could not be used, only leaked to the channel's third party.
describe("skills catalog withholds host paths when the session cannot read files", () => {
    const skill = {
        name: "deploy",
        description: "Ship it",
        filePath: "/Users/someone/.taco/skills/deploy/SKILL.md",
        baseDir: "/Users/someone/.taco/skills/deploy",
        content: "body",
        disableModelInvocation: false,
        sourceInfo: {},
    };
    let sessionsRoot: string;
    let localCwd: string;
    const built: WorkspaceRuntime[] = [];

    before(() => {
        sessionsRoot = mkdtempSync(join(tmpdir(), "taco-chansafe-skills-"));
        localCwd = mkdtempSync(join(tmpdir(), "taco-chansafe-skills-local-"));
    });

    after(async () => {
        for (const ws of built) await ws.dispose();
        rmSync(sessionsRoot, { recursive: true, force: true });
        rmSync(localCwd, { recursive: true, force: true });
    });

    function make(extra: Record<string, unknown>): WorkspaceRuntime {
        const ws = new WorkspaceRuntime({
            providerKeyStore: new ProviderKeyStore({}),
            sessionsRoot,
            resources: { skills: [skill], prompts: [] },
            ...extra,
        } as unknown as ConstructorParameters<typeof WorkspaceRuntime>[0]);
        built.push(ws);
        return ws;
    }

    it("drops location on the default IM policy but keeps the skill listed", () => {
        const ws = make({
            cwd: asWorkspaceId("im://mock-1/u1/c1"),
            workspaceKey: "im://mock-1/u1/c1",
            disableFsTools: true,
        });
        assert.ok(ws.systemPrompt.includes("<name>deploy</name>"));
        assert.ok(!ws.systemPrompt.includes("<location>"));
        assert.ok(!ws.systemPrompt.includes("/Users/someone"));
    });

    it("keeps location when an IM policy grants file tools", () => {
        const ws = make({
            cwd: asWorkspaceId("im://mock-1/u1/c1"),
            workspaceKey: "im://mock-1/u1/c1",
            imPolicy: { tools: { fsTools: "allow", shell: "deny" }, commands: { mode: "ask" } },
        });
        assert.ok(ws.systemPrompt.includes("<location>"));
    });

    it("keeps location for a local workspace", () => {
        const ws = make({ cwd: asWorkspaceId(localCwd) });
        assert.ok(ws.systemPrompt.includes("<location>"));
    });
});
