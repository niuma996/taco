/**
 * ExtensionApi facade unit tests — permission gating is the only logic.
 */

import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";
import type { AgentTool, ContextEvent } from "@earendil-works/pi-agent-core";
import { createExtensionApi } from "../../src/extensions/extensionApi.ts";
import { ExtensionRegistry } from "../../src/extensions/registry.ts";
import type { ExtensionManifest } from "../../src/extensions/types.ts";
import { tagRegistry } from "../../src/tags/registry.ts";
import type { TagSpec } from "../../src/tags/types.ts";

const makeManifest = (perms: ExtensionManifest["permissions"]): ExtensionManifest => ({
    name: "test",
    version: "0.0.1",
    apiVersion: "1",
    permissions: perms,
});

const silentLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
};

const makeTool = (name: string): AgentTool =>
    ({ name, description: "t", execute: async () => ({ text: "" }) }) as unknown as AgentTool;

const makeTagSpec = (overrides: Partial<TagSpec> = {}): TagSpec => ({
    name: "ext_test",
    scope: "user-context",
    compression: { kind: "pin" },
    tuiVisibility: "hidden",
    parser: { kind: "xml-balanced" },
    description: "test extension tag",
    ...overrides,
});

// Helper: tagRegistry has dynamic string keys, so bracket access trips biome's
// useLiteralKeys lint. Route every lookup through Reflect.get to keep the rule
// happy without per-line ignores.
const reg = (name: string): TagSpec | undefined =>
    Reflect.get(tagRegistry, name) as TagSpec | undefined;
const unreg = (name: string): boolean => Reflect.deleteProperty(tagRegistry, name);

describe("createExtensionApi", () => {
    it("exposes manifest and logger", () => {
        const r = new ExtensionRegistry();
        const m = makeManifest([]);
        const api = createExtensionApi(m, r, silentLogger, "external");
        assert.equal(api.manifest, m);
        assert.equal(typeof api.logger.warn, "function");
    });

    it("registerContextHook with 'context' permission stores the hook", () => {
        const r = new ExtensionRegistry();
        const api = createExtensionApi(makeManifest(["context"]), r, silentLogger, "external");
        const hook = async (_e: ContextEvent) => undefined;
        api.registerContextHook(hook);
        assert.equal(r.contextHooks().external.length, 1);
        assert.equal(r.report.unauthorized.length, 0);
    });

    it("registerContextHook without 'context' permission is rejected + reported", () => {
        const r = new ExtensionRegistry();
        const api = createExtensionApi(makeManifest([]), r, silentLogger, "external");
        api.registerContextHook(async () => undefined);
        assert.equal(r.contextHooks().external.length, 0);
        assert.equal(r.report.unauthorized.length, 1);
        assert.equal(r.report.unauthorized[0]?.method, "context");
    });

    it("registerTool requires 'tools' permission", () => {
        const r = new ExtensionRegistry();
        const ok = createExtensionApi(makeManifest(["tools"]), r, silentLogger, "external");
        const denied = createExtensionApi(makeManifest([]), r, silentLogger, "external");
        ok.registerTool(makeTool("ok-tool"));
        denied.registerTool(makeTool("denied-tool"));
        assert.equal(r.tools().length, 1);
        assert.equal(r.report.unauthorized.length, 1);
    });

    it("registerSystemPrompt requires 'systemPrompt' permission", () => {
        const r = new ExtensionRegistry();
        const ok = createExtensionApi(makeManifest(["systemPrompt"]), r, silentLogger, "external");
        const denied = createExtensionApi(makeManifest([]), r, silentLogger, "external");
        ok.registerSystemPrompt({ append: "OK" });
        denied.registerSystemPrompt({ append: "NO" });
        assert.equal(r.systemPromptContributors().length, 1);
        assert.equal(r.report.unauthorized.length, 1);
        assert.equal(r.report.unauthorized[0]?.method, "systemPrompt");
    });

    it("registerTool warns when an extension overrides another extension's tool (design §4.3)", () => {
        const r = new ExtensionRegistry();
        const warns: string[] = [];
        const capturingLogger = {
            info: () => {},
            warn: (m: string) => warns.push(m),
            error: () => {},
            debug: () => {},
        };
        const apiA = createExtensionApi(
            { name: "ext-a", version: "0.0.1", apiVersion: "1", permissions: ["tools"] },
            r,
            capturingLogger,
            "external",
        );
        const apiB = createExtensionApi(
            { name: "ext-b", version: "0.0.1", apiVersion: "1", permissions: ["tools"] },
            r,
            capturingLogger,
            "external",
        );
        apiA.registerTool(makeTool("shared"));
        apiB.registerTool(makeTool("shared"));
        // registry keeps both; dedup happens in WorkspaceRuntime.dedupOverride
        assert.equal(r.toolsWithSource().length, 2);
        assert.ok(
            warns.some((m) =>
                m.includes('extension "ext-b" overrode tool "shared" from extension "ext-a"'),
            ),
            `expected override warn, got: ${JSON.stringify(warns)}`,
        );
    });
});

// Track every tag name added during these tests so we can clean up after each case.
const registeredDuringTest: string[] = [];
function remember(name: string): void {
    registeredDuringTest.push(name);
}

describe("createExtensionApi — registerTag", { concurrency: false }, () => {
    afterEach(() => {
        for (const name of registeredDuringTest) {
            unreg(name);
        }
        registeredDuringTest.length = 0;
    });

    it("registerTag with 'tags' permission stores the tag in tagRegistry", () => {
        const r = new ExtensionRegistry();
        const api = createExtensionApi(
            { name: "ext-tag", version: "0.0.1", apiVersion: "1", permissions: ["tags"] },
            r,
            silentLogger,
            "external",
        );
        remember("ext_unique_a");
        api.registerTag(makeTagSpec({ name: "ext_unique_a" }));
        assert.ok(Object.hasOwn(tagRegistry, "ext_unique_a"));
        assert.equal(reg("ext_unique_a")?.name, "ext_unique_a");
        assert.equal(r.report.failed.length, 0);
    });

    it("registerTag without 'tags' permission is rejected + reported", () => {
        const r = new ExtensionRegistry();
        const api = createExtensionApi(makeManifest([]), r, silentLogger, "external");
        api.registerTag(makeTagSpec({ name: "ext_unique_b" }));
        assert.equal(reg("ext_unique_b"), undefined);
        assert.equal(r.report.unauthorized.length, 1);
        assert.equal(r.report.unauthorized[0]?.method, "tags");
    });

    it("registerTag rejects collision with a builtin name", () => {
        const r = new ExtensionRegistry();
        const api = createExtensionApi(makeManifest(["tags"]), r, silentLogger, "external");
        api.registerTag(makeTagSpec({ name: "instructions" }));
        // builtin must not be overwritten
        assert.match(reg("instructions")?.description ?? "", /Structured/);
        assert.equal(r.report.failed.length, 1);
        assert.match(r.report.failed[0]?.reason ?? "", /instructions/);
    });

    it("registerTag rejects collision between two extensions (first wins)", () => {
        const r = new ExtensionRegistry();
        const apiA = createExtensionApi(
            { name: "ext-a", version: "0.0.1", apiVersion: "1", permissions: ["tags"] },
            r,
            silentLogger,
            "external",
        );
        const apiB = createExtensionApi(
            { name: "ext-b", version: "0.0.1", apiVersion: "1", permissions: ["tags"] },
            r,
            silentLogger,
            "external",
        );
        remember("ext_shared");
        apiA.registerTag(makeTagSpec({ name: "ext_shared", description: "A" }));
        apiB.registerTag(makeTagSpec({ name: "ext_shared", description: "B" }));
        assert.equal(reg("ext_shared")?.description, "A");
        assert.equal(r.report.failed.length, 1);
        assert.equal(r.report.failed[0]?.name, "ext-b");
    });

    it("registerTag rejects empty name", () => {
        const r = new ExtensionRegistry();
        const api = createExtensionApi(makeManifest(["tags"]), r, silentLogger, "external");
        api.registerTag(makeTagSpec({ name: "" }) as TagSpec);
        assert.equal(r.report.failed.length, 1);
    });

    it("registerTag rejects unknown compression kind", () => {
        const r = new ExtensionRegistry();
        const api = createExtensionApi(makeManifest(["tags"]), r, silentLogger, "external");
        api.registerTag({
            name: "ext_bad_compression",
            scope: "user-context",
            compression: { kind: "wat" as unknown as "pin" },
            tuiVisibility: "hidden",
            parser: { kind: "xml-balanced" },
            description: "x",
        });
        assert.equal(reg("ext_bad_compression"), undefined);
        assert.equal(r.report.failed.length, 1);
    });

    it("registerTag rejects unknown scope", () => {
        const r = new ExtensionRegistry();
        const api = createExtensionApi(makeManifest(["tags"]), r, silentLogger, "external");
        api.registerTag({
            name: "ext_bad_scope",
            scope: "wat" as unknown as "user-context",
            compression: { kind: "pin" },
            tuiVisibility: "hidden",
            parser: { kind: "xml-balanced" },
            description: "x",
        });
        assert.equal(reg("ext_bad_scope"), undefined);
        assert.equal(r.report.failed.length, 1);
    });

    it("registerTag rejects opaque parser (removed in v1)", () => {
        const r = new ExtensionRegistry();
        const api = createExtensionApi(makeManifest(["tags"]), r, silentLogger, "external");
        api.registerTag({
            name: "ext_opaque",
            scope: "user-context",
            compression: { kind: "pin" },
            tuiVisibility: "hidden",
            parser: { kind: "opaque" as unknown as "xml-balanced" },
            description: "x",
        });
        assert.equal(reg("ext_opaque"), undefined);
        assert.equal(r.report.failed.length, 1);
    });

    it("LoadedEntry.tags is populated for extensions that registered tags", () => {
        const r = new ExtensionRegistry();
        const api = createExtensionApi(
            { name: "ext-populated", version: "0.0.1", apiVersion: "1", permissions: ["tags"] },
            r,
            silentLogger,
            "external",
        );
        remember("ext_first");
        remember("ext_second");
        api.registerTag(makeTagSpec({ name: "ext_first" }));
        api.registerTag(makeTagSpec({ name: "ext_second" }));
        r.recordLoaded({
            name: "ext-populated",
            version: "0.0.1",
            source: "external",
            permissions: ["tags"],
            tags: r.extensionTagsFor("ext-populated"),
        });
        const entry = r.report.loaded.find((e) => e.name === "ext-populated");
        assert.deepEqual(entry?.tags, ["ext_first", "ext_second"]);
    });
});
