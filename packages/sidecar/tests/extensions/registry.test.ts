/**
 * ExtensionRegistry unit tests.
 *
 * Run: pnpm --filter @taco-ai/sidecar test:extensions
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { AgentTool, ContextEvent, ContextResult } from "@earendil-works/pi-agent-core";
import { ExtensionRegistry } from "../../src/extensions/registry.ts";

const makeTool = (name: string): AgentTool =>
    ({ name, description: "test", execute: async () => ({ text: "" }) }) as unknown as AgentTool;

describe("ExtensionRegistry", () => {
    it("starts empty with zero failed/unauthorized entries", () => {
        const r = new ExtensionRegistry();
        assert.deepEqual(r.tools(), []);
        assert.deepEqual(r.systemPromptContributors(), []);
        assert.deepEqual(r.contextHooks(), { builtins: [], external: [] });
        assert.equal(r.report.loaded.length, 0);
        assert.equal(r.report.failed.length, 0);
        assert.equal(r.report.unauthorized.length, 0);
    });

    it("addContextHook stores by source bucket", () => {
        const r = new ExtensionRegistry();
        const hook = async (_e: ContextEvent): Promise<ContextResult> => ({ messages: [] });
        r.addContextHook("builtin", hook);
        r.addContextHook("external", hook);
        const all = r.contextHooks();
        assert.equal(all.builtins.length, 1);
        assert.equal(all.external.length, 1);
    });

    it("addTool stores tools in registration order, no dedup", () => {
        const r = new ExtensionRegistry();
        r.addTool("ext-a", makeTool("a"));
        r.addTool("ext-b", makeTool("b"));
        r.addTool("ext-a2", makeTool("a")); // registry does not dedup; that happens in WorkspaceRuntime
        const names = r.tools().map((t) => t.name);
        assert.deepEqual(names, ["a", "b", "a"]);
    });

    it("toolsWithSource retains contributing extension name", () => {
        const r = new ExtensionRegistry();
        r.addTool("ext-a", makeTool("a"));
        r.addTool("ext-b", makeTool("b"));
        const withSource = r.toolsWithSource();
        assert.deepEqual(
            withSource.map((e) => ({ name: e.name, toolName: e.tool.name })),
            [
                { name: "ext-a", toolName: "a" },
                { name: "ext-b", toolName: "b" },
            ],
        );
    });

    it("addSystemPromptContributor stores in registration order", () => {
        const r = new ExtensionRegistry();
        r.addSystemPromptContributor({ append: "B" });
        r.addSystemPromptContributor({ append: "E" });
        const c = r.systemPromptContributors();
        assert.equal(c.length, 2);
        assert.deepEqual(c[0], { append: "B" });
        assert.deepEqual(c[1], { append: "E" });
    });

    it("recordFailed and recordUnauthorized append to report", () => {
        const r = new ExtensionRegistry();
        r.recordFailed("x", "boom");
        r.recordUnauthorized("y", "tools");
        assert.equal(r.report.failed.length, 1);
        assert.equal(r.report.failed[0]?.name, "x");
        assert.equal(r.report.unauthorized[0]?.name, "y");
    });

    it("recordLoaded populates report.loaded", () => {
        const r = new ExtensionRegistry();
        r.recordLoaded({
            name: "a",
            version: "1.0.0",
            source: "external",
            permissions: ["context"],
        });
        r.recordLoaded({
            name: "b",
            version: "0.1.0",
            source: "builtin",
            permissions: ["systemPrompt"],
        });
        assert.equal(r.report.loaded.length, 2);
        assert.equal(r.report.loaded[0]?.name, "a");
    });

    it("recordLoaded carries description and whenToUse", () => {
        const r = new ExtensionRegistry();
        r.recordLoaded({
            name: "a",
            version: "1.0.0",
            source: "external",
            permissions: ["context"],
            description: "does a thing",
            whenToUse: "when you need a",
        });
        assert.equal(r.report.loaded[0]?.description, "does a thing");
        assert.equal(r.report.loaded[0]?.whenToUse, "when you need a");
    });

    it("recordDisabled appends names to report.disabled", () => {
        const r = new ExtensionRegistry();
        r.recordDisabled("ext-x");
        r.recordDisabled("ext-y");
        assert.deepEqual(r.report.disabled, ["ext-x", "ext-y"]);
    });

    it("starts with empty disabled bucket", () => {
        const r = new ExtensionRegistry();
        assert.deepEqual(r.report.disabled, []);
    });
});
