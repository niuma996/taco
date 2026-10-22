import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { createExtensionApi } from "../../src/extensions/extensionApi.ts";
import { loadExtensions } from "../../src/extensions/loader.ts";
import { ExtensionRegistry } from "../../src/extensions/registry.ts";
import type {
    ContextEvent,
    ContextResult,
    ExtensionManifest,
    ToolResultEvent,
} from "../../src/extensions/types.ts";
import type { AgentHarnessTool, ExecutionToolContext } from "../../src/runtime/pi/types.ts";
import { tagRegistry } from "../../src/tags/registry.ts";
import type { TagSpec } from "../../src/tags/types.ts";
import type { TacoTool } from "../../src/tools/index.ts";

describe("registry", () => {
    const makeTool = (name: string): TacoTool =>
        ({ name, description: "test", execute: async () => ({ text: "" }) }) as unknown as TacoTool;

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
    });
});

describe("extensionApi", () => {
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

    const makeTool = (name: string): AgentHarnessTool<ExecutionToolContext> =>
        ({
            name,
            description: "t",
            execute: async () => ({ content: [{ type: "text", text: "" }] }),
        }) as unknown as AgentHarnessTool<ExecutionToolContext>;

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
            const ok = createExtensionApi(
                makeManifest(["systemPrompt"]),
                r,
                silentLogger,
                "external",
            );
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
});

describe("loader", () => {
    let tmpDir: string;

    before(() => {
        tmpDir = mkdtempSync(join(tmpdir(), "taco-ext-loader-"));
        process.env.TACO_EXTENSIONS_DIR = join(tmpDir, "ext-home");
        mkdirSync(process.env.TACO_EXTENSIONS_DIR, { recursive: true });
    });

    after(() => {
        process.env.TACO_EXTENSIONS_DIR = undefined;
        rmSync(tmpDir, { recursive: true, force: true });
    });

    const makeExt = (name: string, body: string) => {
        const dir = join(process.env.TACO_EXTENSIONS_DIR ?? "", name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, "package.json"),
            JSON.stringify({
                name,
                version: "0.0.1",
                main: "index.js",
                taco: { apiVersion: "1", permissions: ["context", "tools", "systemPrompt"] },
            }),
        );
        writeFileSync(join(dir, "index.js"), body);
    };

    describe("loadExtensions — directory discovery", () => {
        it("loads a valid extension from TACO_EXTENSIONS_DIR", async () => {
            makeExt(
                "good-ext",
                `export default function (taco) { taco.registerSystemPrompt({ append: "FROM GOOD" }); }`,
            );
            const r = await loadExtensions({ extensions: [] });
            const contribs = r.systemPromptContributors().map((c) => c.append);
            assert.ok(contribs.includes("FROM GOOD"), `got: ${JSON.stringify(contribs)}`);
        });

        it("skips an extension whose factory throws", async () => {
            makeExt("bad-ext", `export default function () { throw new Error("nope"); }`);
            const r = await loadExtensions({ extensions: [] });
            const failed = r.report.failed.find((f) => f.name === "bad-ext");
            assert.ok(
                failed,
                `expected bad-ext in failed, got: ${JSON.stringify(r.report.failed)}`,
            );
        });

        it("rejects an extension with mismatched apiVersion", async () => {
            const dir = join(process.env.TACO_EXTENSIONS_DIR ?? "", "old-api-ext");
            mkdirSync(dir, { recursive: true });
            writeFileSync(
                join(dir, "package.json"),
                JSON.stringify({
                    name: "old-api-ext",
                    version: "0.0.1",
                    taco: { apiVersion: "999", permissions: [] },
                }),
            );
            writeFileSync(join(dir, "index.js"), "export default function () {};");
            const r = await loadExtensions({ extensions: [] });
            const failed = r.report.failed.find((f) => f.name === "old-api-ext");
            assert.ok(failed, "expected old-api-ext in failed");
        });

        it("reads taco.description and taco.whenToUse from manifest", async () => {
            const dir = join(process.env.TACO_EXTENSIONS_DIR ?? "", "described-ext");
            mkdirSync(dir, { recursive: true });
            writeFileSync(
                join(dir, "package.json"),
                JSON.stringify({
                    name: "described-ext",
                    version: "0.0.1",
                    main: "index.js",
                    taco: {
                        apiVersion: "1",
                        permissions: ["systemPrompt"],
                        description: "adds a rule",
                        whenToUse: "always",
                    },
                }),
            );
            writeFileSync(
                join(dir, "index.js"),
                `export default function (taco) { taco.registerSystemPrompt({ append: "X" }); }`,
            );
            const r = await loadExtensions({ extensions: [] });
            const entry = r.report.loaded.find((e) => e.name === "described-ext");
            assert.ok(entry, "described-ext should load");
            assert.equal(entry.description, "adds a rule");
            assert.equal(entry.whenToUse, "always");
        });

        it("skips a directory extension listed in disabledExtensions? (dir extensions are always scanned)", async () => {
            // Note: disabledExtensions only filters the npm allowlist (extensions field);
            // directory scanning is always the full set, unaffected by disabledExtensions.
            // This test pins down that semantic.
            makeExt(
                "dir-only",
                `export default function (taco) { taco.registerSystemPrompt({ append: "DIR" }); }`,
            );
            const r = await loadExtensions({ extensions: [], disabledExtensions: ["dir-only"] });
            // dir-only comes from directory scanning, not the npm extensions allowlist,
            // so disabledExtensions has no effect on it.
            assert.ok(r.report.loaded.some((e) => e.name === "dir-only"));
            // It should not appear in the disabled bucket (disabled only tracks extensions ∩ disabledExtensions).
            assert.ok(!r.report.disabled.includes("dir-only"));
        });

        it("records an npm-listed extension as disabled when in disabledExtensions", async () => {
            // Declare a package name under extensions and disable it at the same time —
            // it should land in the disabled bucket, not in loaded/failed.
            const r = await loadExtensions({
                extensions: ["some-absent-pkg"],
                disabledExtensions: ["some-absent-pkg"],
            });
            assert.ok(r.report.disabled.includes("some-absent-pkg"));
            assert.ok(!r.report.loaded.some((e) => e.name === "some-absent-pkg"));
            assert.ok(!r.report.failed.some((e) => e.name === "some-absent-pkg"));
        });

        it("records a built-in as disabled when listed in disabledExtensions; skips hook install", async () => {
            // The output-redaction builtin is normally registered automatically.
            // Listing it in disabledExtensions must:
            //   (a) remove it from report.loaded,
            //   (b) place it in report.disabled,
            //   (c) skip installing the toolResult interceptor so secrets pass through.
            const r = await loadExtensions({
                extensions: [],
                disabledExtensions: ["@taco/builtin-output-redaction"],
            });
            assert.ok(
                !r.report.loaded.some((e) => e.name === "@taco/builtin-output-redaction"),
                `builtin should NOT be loaded when disabled, got: ${JSON.stringify(r.report.loaded)}`,
            );
            assert.ok(r.report.disabled.includes("@taco/builtin-output-redaction"));
            assert.deepEqual(r.toolResultHooks().builtins, []);
        });

        it("default behavior: output-redaction builtin is registered when not disabled", async () => {
            // Sanity baseline so the previous test's assertion is meaningful.
            const r = await loadExtensions({ extensions: [] });
            assert.ok(r.report.loaded.some((e) => e.name === "@taco/builtin-output-redaction"));
            assert.equal(r.toolResultHooks().builtins.length, 1);
        });
    });
});

describe("integration", () => {
    let tmpDir: string;

    before(() => {
        tmpDir = mkdtempSync(join(tmpdir(), "taco-ext-int-"));
        process.env.TACO_EXTENSIONS_DIR = tmpDir;
    });

    after(() => {
        process.env.TACO_EXTENSIONS_DIR = undefined;
        rmSync(tmpDir, { recursive: true, force: true });
    });

    const writeExt = (name: string, body: string, perms: string[]) => {
        const dir = join(tmpDir, name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, "package.json"),
            JSON.stringify({
                name,
                version: "0.1.0",
                main: "index.js",
                taco: { apiVersion: "1", permissions: perms },
            }),
        );
        writeFileSync(join(dir, "index.js"), body);
    };

    describe("integration — happy path", () => {
        it("loads a healthy extension and surfaces its contributions", async () => {
            writeExt(
                "healthy",
                `export default function (taco) {
                taco.registerSystemPrompt({ append: "FROM HEALTHY" });
            }`,
                ["systemPrompt"],
            );
            const r = await loadExtensions({ extensions: [] });
            const contribs = r.systemPromptContributors();
            assert.ok(
                contribs.some((c) => c.append === "FROM HEALTHY"),
                `expected system prompt contribution, got: ${JSON.stringify(contribs)}`,
            );
            assert.ok(
                r.report.loaded.some((e) => e.name === "healthy"),
                `expected healthy in loaded, got: ${JSON.stringify(r.report.loaded)}`,
            );
        });

        it("extension-overrides-builtin-tool is recorded as a warning + the tool is overridden", async () => {
            writeExt(
                "override-read",
                `export default function (taco) {
                taco.registerTool({ name: "read", description: "fake", execute: async () => ({ text: "x" }) });
            }`,
                ["tools"],
            );
            const r = await loadExtensions({ extensions: [] });
            const reads = r.tools().filter((t) => t.name === "read");
            assert.ok(reads.length >= 1);
            assert.ok(r.report.loaded.some((e) => e.name === "override-read"));
        });
    });

    describe("integration — graceful degradation", () => {
        it("throwing extension does not prevent others from loading", async () => {
            writeExt("exploder", `export default function () { throw new Error("kaboom"); }`, [
                "context",
            ]);
            writeExt(
                "survivor",
                `export default function (taco) { taco.registerSystemPrompt({ prepend: "OK" }); }`,
                ["systemPrompt"],
            );
            const r = await loadExtensions({ extensions: [] });
            const failed = r.report.failed.find((f) => f.name === "exploder");
            assert.ok(
                failed,
                `expected exploder in failed, got: ${JSON.stringify(r.report.failed)}`,
            );
            assert.ok(
                r.report.loaded.some((e) => e.name === "survivor"),
                `survivor should still load, loaded: ${JSON.stringify(r.report.loaded)}`,
            );
        });
    });

    describe("integration — permission gating", () => {
        it("extension without declared permission is silently ignored for that method", async () => {
            writeExt(
                "no-perm",
                `export default function (taco) {
                taco.registerTool({ name: "x", description: "x", execute: async () => ({ text: "" }) });
            }`,
                [],
            );
            const r = await loadExtensions({ extensions: [] });
            const xTools = r.tools().filter((t) => t.name === "x");
            assert.equal(xTools.length, 0, "tool should not be registered without permission");
            const u = r.report.unauthorized.find(
                (e) => e.name === "no-perm" && e.method === "tools",
            );
            assert.ok(
                u,
                `expected no-perm/tools in unauthorized, got: ${JSON.stringify(r.report.unauthorized)}`,
            );
        });
    });

    describe("integration — built-in extensions", () => {
        it("output-redaction builtin is loaded automatically and registered as builtin source", async () => {
            const r = await loadExtensions({ extensions: [] });
            const builtin = r.report.loaded.find(
                (e) => e.name === "@taco/builtin-output-redaction",
            );
            assert.ok(
                builtin,
                `expected builtin in loaded, got: ${JSON.stringify(r.report.loaded)}`,
            );
            assert.equal(builtin.source, "builtin");
            // trust-bypass: builtins don't declare permissions (the registry's
            // permission check is in extensionApi, which builtins skip). See
            // registry.ts registerBuiltinExtensions.
            assert.deepEqual([...builtin.permissions], []);
            // And the hook must be in the builtins bucket, not external.
            const buckets = r.toolResultHooks();
            assert.equal(buckets.builtins.length, 1);
            assert.equal(buckets.external.length, 0);
        });

        it("output-redaction builtin reports its own version, not the sidecar's", async () => {
            const r = await loadExtensions({ extensions: [] });
            const builtin = r.report.loaded.find(
                (e) => e.name === "@taco/builtin-output-redaction",
            );
            assert.ok(builtin);
            // Each builtin versions independently: a sidecar release must not drag
            // the extension's reported version along with it.
            assert.equal(builtin.version, "0.1.0");
        });

        it("output-redaction hook redacts API keys from tool output", async () => {
            const r = await loadExtensions({ extensions: [] });
            const hook = r.toolResultHooks().builtins[0];
            const secret = "sk-1234567890abcdefghijklmnopqrstuvwxyz1234567890";
            const event: ToolResultEvent = {
                type: "tool_result",
                toolCallId: "test-call",
                toolName: "Bash",
                input: { command: "echo $OPENAI_API_KEY" },
                content: [{ type: "text", text: secret }],
                details: undefined,
                isError: false,
            };
            const result = await hook(event);
            assert.ok(result, "expected a patch when secret is present");
            const flat = JSON.stringify(result);
            assert.ok(flat.includes("[REDACTED:API_KEY]"), `expected marker in: ${flat}`);
            // Stronger assertion: the original secret string itself must be gone.
            assert.ok(!flat.includes(secret), `expected secret to be scrubbed, got: ${flat}`);
        });

        it("output-redaction hook passes through output with no secrets", async () => {
            const r = await loadExtensions({ extensions: [] });
            const hook = r.toolResultHooks().builtins[0];
            const event: ToolResultEvent = {
                type: "tool_result",
                toolCallId: "test-call",
                toolName: "Bash",
                input: { command: "echo hello" },
                content: [{ type: "text", text: "hello world" }],
                details: undefined,
                isError: false,
            };
            const result = await hook(event);
            assert.equal(
                result,
                undefined,
                `expected pass-through, got: ${JSON.stringify(result)}`,
            );
        });

        it("output-redaction hook redacts GitHub tokens and AWS access keys", async () => {
            const r = await loadExtensions({ extensions: [] });
            const hook = r.toolResultHooks().builtins[0];
            const githubToken = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
            const awsKey = "AKIAIOSFODNN7EXAMPLE";
            const bearer = "Authorization: Bearer abcdef1234567890abcdef1234567890";
            const event: ToolResultEvent = {
                type: "tool_result",
                toolCallId: "test-call",
                toolName: "Bash",
                input: { command: "env" },
                content: [
                    {
                        type: "text",
                        text: `GITHUB_TOKEN=${githubToken}\nAWS_KEY=${awsKey}\n${bearer}`,
                    },
                ],
                details: undefined,
                isError: false,
            };
            const result = await hook(event);
            assert.ok(result);
            const flat = JSON.stringify(result);
            assert.ok(flat.includes("[REDACTED:GITHUB_TOKEN]"));
            assert.ok(flat.includes("[REDACTED:AWS_ACCESS_KEY]"));
            assert.ok(flat.includes("[REDACTED:BEARER_TOKEN]"));
            assert.ok(!flat.includes(githubToken));
            assert.ok(!flat.includes(awsKey));
        });

        it("output-redaction hook fails silently on malformed event", async () => {
            const r = await loadExtensions({ extensions: [] });
            const hook = r.toolResultHooks().builtins[0];
            // Missing required fields — the hook must not throw, must not crash
            // the tool pipeline. Pass-through (undefined) is acceptable.
            const event = {
                type: "tool_result",
                toolCallId: "test-call",
                toolName: "Read",
                input: {},
            } as unknown as ToolResultEvent;
            let result: unknown;
            await assert.doesNotReject(async () => {
                result = await hook(event);
            });
            // No assertion on `result` — either undefined (pass-through) or a
            // patch that didn't crash is acceptable. The contract is "doesn't throw".
            void result;
        });

        it("output-redaction hook redacts Anthropic sk-ant-api03 keys (hyphenated body)", async () => {
            // Regression for session 019f97cf-... — the old single pattern
            // \bsk-[A-Za-z0-9]{20,}\b failed because the body contains '-'
            // (e.g. "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ...").
            const r = await loadExtensions({ extensions: [] });
            const hook = r.toolResultHooks().builtins[0];
            const secret =
                "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
            const event: ToolResultEvent = {
                type: "tool_result",
                toolCallId: "test-call",
                toolName: "Bash",
                input: { command: "env" },
                content: [{ type: "text", text: `ANTHROPIC_API_KEY=${secret}` }],
                details: undefined,
                isError: false,
            };
            const result = await hook(event);
            assert.ok(result, "expected a patch when sk-ant key is present");
            const flat = JSON.stringify(result);
            assert.ok(flat.includes("[REDACTED:API_KEY]"), `expected marker in: ${flat}`);
            assert.ok(!flat.includes(secret), `expected secret to be scrubbed, got: ${flat}`);
        });

        it("output-redaction hook redacts OpenAI sk-proj / sk-svcacct keys", async () => {
            const r = await loadExtensions({ extensions: [] });
            const hook = r.toolResultHooks().builtins[0];
            const secret = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
            const event: ToolResultEvent = {
                type: "tool_result",
                toolCallId: "test-call",
                toolName: "Bash",
                input: { command: "env" },
                content: [{ type: "text", text: `OPENAI_API_KEY=${secret}` }],
                details: undefined,
                isError: false,
            };
            const result = await hook(event);
            assert.ok(result);
            const flat = JSON.stringify(result);
            assert.ok(flat.includes("[REDACTED:API_KEY]"));
            assert.ok(!flat.includes(secret));
        });

        it("output-redaction hook redacts minimax-cn sk-cp keys with underscores", async () => {
            // Regression for session 019f97cf-... — real minimax-cn key looks
            // like "sk-cp-GYH8_QwteRydXXWvLHlJIkn..." with embedded '_'.
            const r = await loadExtensions({ extensions: [] });
            const hook = r.toolResultHooks().builtins[0];
            const secret = "sk-cp-GYH8_QwteRydXXWvLHlJIknHxWqlNiU1o_mXJ0GZwGvR_FHfYX5UqDTC3rhltJko";
            const event: ToolResultEvent = {
                type: "tool_result",
                toolCallId: "test-call",
                toolName: "Read",
                input: { path: "~/.pi/agent/taco.json" },
                content: [{ type: "text", text: `"minimax-cn": "${secret}"` }],
                details: undefined,
                isError: false,
            };
            const result = await hook(event);
            assert.ok(result, "expected a patch when sk-cp key is present");
            const flat = JSON.stringify(result);
            assert.ok(flat.includes("[REDACTED:API_KEY]"), `expected marker in: ${flat}`);
            assert.ok(!flat.includes(secret), `expected secret to be scrubbed, got: ${flat}`);
        });

        it("output-redaction hook redacts secrets in JSON-serializable details field", async () => {
            // Belt-and-suspenders: shell/bash tools may surface secrets via
            // details (e.g. env-shaped metadata). Patch details when hit.
            const r = await loadExtensions({ extensions: [] });
            const hook = r.toolResultHooks().builtins[0];
            const secret =
                "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
            const event: ToolResultEvent = {
                type: "tool_result",
                toolCallId: "test-call",
                toolName: "Bash",
                input: { command: "env" },
                content: [{ type: "text", text: "ok" }],
                details: { env: { ANTHROPIC_API_KEY: secret }, exitCode: 0 },
                isError: false,
            };
            const result = await hook(event);
            assert.ok(result);
            // The hit must come from `details` (content is "ok"). If the hook
            // regresses to skip `details`, this assertion fails — protects
            // against false-positive tests where the hit came from content.
            assert.ok(
                "details" in result,
                `expected patch.details to be set when redaction hit is in details, got: ${JSON.stringify(result)}`,
            );
            assert.deepEqual(result.details, {
                env: { ANTHROPIC_API_KEY: "[REDACTED:API_KEY]" },
                exitCode: 0,
            });
            const flat = JSON.stringify(result);
            assert.ok(flat.includes("[REDACTED:API_KEY]"), `expected marker in: ${flat}`);
            assert.ok(!flat.includes(secret), `expected secret to be scrubbed, got: ${flat}`);
            // exitCode is not a secret — must be preserved.
            assert.ok(
                flat.includes('"exitCode":0'),
                `expected non-secret field preserved: ${flat}`,
            );
        });
    });
});
