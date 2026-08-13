/**
 * Regression tests for WorkspaceRuntime extension integration.
 * Covers: constructor ordering bug (registry read before assigned, fixed by assigning first)
 * and tool dedup bug (extension overriding builtin via dedupe by name).
 * Harness not exercised — asserts only on `WorkspaceRuntime.tools` and `.systemPrompt`.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { activateExtensions } from "../../src/extensions/activation.ts";
import { createExtensionApi } from "../../src/extensions/extensionApi.ts";
import { ExtensionRegistry } from "../../src/extensions/registry.ts";
import { ProviderKeyStore } from "../../src/runtime/providerKeyStore.ts";
import { WorkspaceRuntime } from "../../src/runtime/workspace.ts";

let tmpDir: string;

before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "taco-ws-reg-"));
});

after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
});

const fakeTool = (name: string): AgentTool =>
    ({ name, description: "fake", execute: async () => ({ text: "" }) }) as unknown as AgentTool;

const silentLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
};

const makeRegistry = (
    tools: AgentTool[],
    prompts: Array<{ prepend?: string; append?: string }>,
) => {
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
    it("applies extension tools to this.tools (no longer dropped by constructor order)", async () => {
        const registry = makeRegistry([fakeTool("ext-tool")], []);
        const extensions = await activateExtensions(registry, { cwd: tmpDir });
        const ws = new WorkspaceRuntime({
            providerKeyStore: new ProviderKeyStore({}),
            cwd: tmpDir,
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
        const extensions = await activateExtensions(registry, { cwd: tmpDir });
        const ws = new WorkspaceRuntime({
            providerKeyStore: new ProviderKeyStore({}),
            cwd: tmpDir,
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
        const extensions = await activateExtensions(r, { cwd: tmpDir });
        const ws = new WorkspaceRuntime({
            providerKeyStore: new ProviderKeyStore({}),
            cwd: tmpDir,
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
        const extensions = await activateExtensions(registry, { cwd: tmpDir });
        const ws = new WorkspaceRuntime({
            providerKeyStore: new ProviderKeyStore({}),
            cwd: tmpDir,
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
            cwd: tmpDir,
            tools: [fakeTool("only-builtin")],
            systemPrompt: "USER-PROMPT",
        });
        const names = ws.tools.map((t) => t.name);
        assert.deepEqual(names, ["only-builtin"]);
        assert.ok(ws.systemPrompt.includes("USER-PROMPT"));
    });
});
