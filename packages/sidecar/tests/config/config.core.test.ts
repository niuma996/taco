// Core config tests: round-trip persistence, corrupt-file handling, tacoHome paths, compaction.

import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import type { GlobalConfigPatch, TacoGlobalConfigShape } from "@taco-ai/protocol";
import {
    COMPACTION_THRESHOLD_MAX,
    COMPACTION_THRESHOLD_MIN,
    DEFAULT_COMPACTION_ENABLED,
    DEFAULT_COMPACTION_THRESHOLD,
} from "@taco-ai/protocol";
import {
    defaultSessionsRoot,
    defaultSkillDirs,
    mergeCompactionPatch,
    readGlobalConfig,
    resolveConfig,
    saveGlobalConfig,
    tacoHome,
    validateCompactionConfig,
} from "../../src/config/config.ts";
import { useTempTacoHome } from "../_helpers/tempTacoHome.ts";

describe("saveGlobalConfig round-trip", () => {
    useTempTacoHome("config-roundtrip");

    // Covers every scalar field. A fresh file must round-trip the written value.
    // Note: theme / debugMode have been removed from TacoGlobalConfigShape; they are not
    // part of the sidecar protocol.
    const scalars: ReadonlyArray<{
        readonly name: keyof TacoGlobalConfigShape;
        readonly value: unknown;
    }> = [
        { name: "defaultModel", value: "anthropic/claude-sonnet" },
        { name: "defaultProvider", value: "anthropic" },
        { name: "sessionsRoot", value: "/tmp/sessions" },
        { name: "systemPrompt", value: "be terse" },
        { name: "thinkingLevel", value: "medium" },
        { name: "anthropicApiKey", value: "sk-ant-test" },
        { name: "openaiApiKey", value: "sk-openai-test" },
        {
            name: "commandPermissions",
            value: { mode: "auto", allow: ["pnpm test"], deny: [] },
        },
        { name: "extensions", value: ["@taco/ext-a", "@taco/ext-b"] },
        { name: "disabledExtensions", value: ["@taco/ext-b"] },
    ];

    const clearable: ReadonlySet<keyof TacoGlobalConfigShape> = new Set([
        "defaultModel",
        "defaultProvider",
        "sessionsRoot",
        "systemPrompt",
        "thinkingLevel",
        "anthropicApiKey",
        "openaiApiKey",
    ]);

    for (const { name, value } of scalars) {
        it(`persists scalar field ${String(name)}`, () => {
            saveGlobalConfig({ [name]: value } as Partial<TacoGlobalConfigShape>);
            const after = readGlobalConfig();
            assert.deepEqual(
                after[name],
                value,
                `saveGlobalConfig dropped the field "${String(name)}" — add it to the patch handler`,
            );
        });
    }

    // A clear arrives as `null` (undefined keys vanish in JSON.stringify) and
    // must be stored as an absent key, not a persisted `null`.
    for (const { name, value } of scalars.filter((s) => clearable.has(s.name))) {
        it(`clears scalar field ${String(name)} on null`, () => {
            saveGlobalConfig({ [name]: value } as GlobalConfigPatch);
            saveGlobalConfig({ [name]: null } as GlobalConfigPatch);
            const after = readGlobalConfig();
            assert.equal(after[name], undefined);
            assert.ok(!(name in after), `"${String(name)}" persisted as a key after a null clear`);
        });
    }

    it("apiKeys is shallow-merged, not replaced", () => {
        saveGlobalConfig({ apiKeys: { a: "1", b: "2" } });
        saveGlobalConfig({ apiKeys: { b: "3", c: "4" } });
        assert.deepEqual(readGlobalConfig().apiKeys, { a: "1", b: "3", c: "4" });
    });

    it("compaction is shallow-merged, not replaced", () => {
        // Write enabled=true / threshold=0.5, then patch threshold=0.6 alone — enabled must be preserved.
        saveGlobalConfig({ compaction: { enabled: true, threshold: 0.5 } });
        saveGlobalConfig({ compaction: { threshold: 0.6 } });
        const after = readGlobalConfig();
        assert.deepEqual(after.compaction, { enabled: true, threshold: 0.6 });
    });
});

describe("config corrupt-file handling", () => {
    const dirs: string[] = [];
    let prevTacoHome: string | undefined;

    after(() => {
        if (prevTacoHome === undefined) {
            Reflect.deleteProperty(process.env, "TACO_HOME");
        } else {
            process.env.TACO_HOME = prevTacoHome;
        }
        for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    });

    /** Point TACO_HOME at a fresh empty temp dir — cold cache for this test. */
    function useFreshHome(): string {
        if (prevTacoHome === undefined) prevTacoHome = process.env.TACO_HOME;
        const dir = mkdtempSync(join(tmpdir(), "taco-config-corrupt-"));
        dirs.push(dir);
        process.env.TACO_HOME = dir;
        return dir;
    }

    it("throws on malformed JSON instead of silently returning {}", () => {
        const dir = useFreshHome();
        writeFileSync(join(dir, "taco.json"), "{this is not valid json", "utf8");
        assert.throws(() => readGlobalConfig(), /Unexpected token|Expected|JSON/);
    });

    it("recovers after the file is repaired — a failure must not poison the cache", () => {
        const dir = useFreshHome();
        const path = join(dir, "taco.json");
        writeFileSync(path, "{this is not valid json", "utf8");
        assert.throws(() => readGlobalConfig(), /Unexpected token|Expected|JSON/);

        // Repair the file: the next read must succeed, proving the failed read
        // was not frozen into the process cache.
        writeFileSync(path, JSON.stringify({ defaultModel: "anthropic/claude-sonnet" }), "utf8");
        assert.equal(readGlobalConfig().defaultModel, "anthropic/claude-sonnet");
    });

    it("a missing file is unconfigured ({}), not an error", () => {
        useFreshHome();
        assert.deepEqual(readGlobalConfig(), {});
    });

    it("saveGlobalConfig also refuses to run on a corrupt file (no silent wipe)", () => {
        const dir = useFreshHome();
        const path = join(dir, "taco.json");
        writeFileSync(path, "{this is not valid json", "utf8");
        assert.throws(() => readGlobalConfig(), /Unexpected token|Expected|JSON/);

        // A save on a corrupt file reads it first (readJsonOrEmpty) to merge the
        // patch — that read throws, so the save aborts instead of replacing the
        // user's config with a patch-only file. This is the safe failure mode.
        assert.throws(() => saveGlobalConfig({ defaultProvider: "anthropic" }));
        // The corrupt original is left untouched on disk.
        assert.equal(readFileSync(path, "utf8"), "{this is not valid json");
    });
});

describe("tacoHome", () => {
    let prevTacoHome: string | undefined;
    let prevPiAgentDir: string | undefined;

    before(() => {
        prevTacoHome = process.env.TACO_HOME;
        prevPiAgentDir = process.env.PI_AGENT_DIR;
    });

    after(() => {
        if (prevTacoHome === undefined) Reflect.deleteProperty(process.env, "TACO_HOME");
        else process.env.TACO_HOME = prevTacoHome;
        if (prevPiAgentDir === undefined) Reflect.deleteProperty(process.env, "PI_AGENT_DIR");
        else process.env.PI_AGENT_DIR = prevPiAgentDir;
    });

    it("default to ~/.taco when TACO_HOME is unset", () => {
        Reflect.deleteProperty(process.env, "TACO_HOME");
        assert.equal(tacoHome(), resolve(homedir(), ".taco"));
    });

    it("respect TACO_HOME env override", () => {
        const tmp = mkdtempSync(join(tmpdir(), "taco-home-"));
        process.env.TACO_HOME = tmp;
        try {
            assert.equal(tacoHome(), tmp);
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });

    // Boundary cases must match src-tauri/src/lib.rs resolve_taco_home exactly;
    // a divergence puts desktop.json and sessions/ in different directories
    // while both appear to "use TACO_HOME".
    it("treats an empty TACO_HOME as unset", () => {
        process.env.TACO_HOME = "";
        assert.equal(tacoHome(), resolve(homedir(), ".taco"));
    });

    it("treats a whitespace-only TACO_HOME as unset", () => {
        process.env.TACO_HOME = "   ";
        assert.equal(tacoHome(), resolve(homedir(), ".taco"));
    });

    it("absolutizes a relative TACO_HOME against cwd", () => {
        process.env.TACO_HOME = "state";
        const got = tacoHome();
        assert.equal(got, resolve(process.cwd(), "state"));
        // Platform-correct absolute check: Windows absolutes are drive-lettered
        // (`D:\...`), not `/`-prefixed, so `startsWith("/")` would misfire there.
        assert.ok(isAbsolute(got), "must be absolute");
    });

    it("trims surrounding whitespace from an absolute TACO_HOME", () => {
        const tmp = mkdtempSync(join(tmpdir(), "taco-pad-"));
        process.env.TACO_HOME = `  ${tmp}  `;
        try {
            assert.equal(tacoHome(), tmp);
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });
});

describe("defaultSkillDirs / defaultSessionsRoot", () => {
    let prevTacoHome: string | undefined;
    let prevSessionsRootOverride: string | undefined;

    before(() => {
        prevTacoHome = process.env.TACO_HOME;
        prevSessionsRootOverride = process.env.TACO_SESSIONS_ROOT;
    });

    after(() => {
        if (prevTacoHome === undefined) Reflect.deleteProperty(process.env, "TACO_HOME");
        else process.env.TACO_HOME = prevTacoHome;
        if (prevSessionsRootOverride === undefined)
            Reflect.deleteProperty(process.env, "TACO_SESSIONS_ROOT");
        else process.env.TACO_SESSIONS_ROOT = prevSessionsRootOverride;
    });

    it("defaultSkillDirs returns multi-source array with project .taco first, builtin last", () => {
        const tmpTacoHome = mkdtempSync(join(tmpdir(), "taco-skills-"));
        process.env.TACO_HOME = tmpTacoHome;
        try {
            const cwd = mkdtempSync(join(tmpdir(), "taco-skills-cwd-"));
            try {
                // defaultSkillDirs normalizes to forward slashes even on Windows
                // (pi-agent-core's relativeEnvPath compares with "/" separators), so
                // compare against the forward-slash form of the expected native path.
                const fwd = (p: string) => p.replace(/\\/g, "/");
                const dirs = defaultSkillDirs(cwd);
                assert.equal(dirs.length, 5, "should have exactly 5 entries");
                // Project .taco/skills must be first (highest priority, first-wins dedup)
                assert.equal(dirs[0].path, fwd(resolve(cwd, ".taco", "skills")));
                assert.equal(dirs[0].source, "user");
                // Global TACO_HOME second
                assert.equal(dirs[1].path, fwd(resolve(tmpTacoHome, "skills")));
                assert.equal(dirs[1].source, "user");
                assert.equal(dirs[2].path, fwd(resolve(homedir(), ".claude", "skills")));
                assert.equal(dirs[2].source, "user");
                assert.equal(dirs[3].path, fwd(resolve(homedir(), ".pi", "skills")));
                assert.equal(dirs[3].source, "user");
                // Builtin directory last (lowest priority; overridable by all four above)
                assert.equal(dirs[4].source, "builtin");
                assert.ok(dirs[4].path.endsWith(fwd(join("skills", "builtin"))));
            } finally {
                rmSync(cwd, { recursive: true, force: true });
            }
        } finally {
            rmSync(tmpTacoHome, { recursive: true, force: true });
        }
    });

    it("defaultSessionsRoot uses TACO_HOME", () => {
        const tmp = mkdtempSync(join(tmpdir(), "taco-sessions-"));
        process.env.TACO_HOME = tmp;
        try {
            assert.equal(defaultSessionsRoot(), join(tmp, "sessions"));
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });

    it("defaultSessionsRoot respects TACO_SESSIONS_ROOT override", () => {
        const tmp = mkdtempSync(join(tmpdir(), "taco-sessions-override-"));
        process.env.TACO_SESSIONS_ROOT = tmp;
        try {
            assert.equal(defaultSessionsRoot(), tmp);
        } finally {
            rmSync(tmp, { recursive: true, force: true });
            Reflect.deleteProperty(process.env, "TACO_SESSIONS_ROOT");
        }
    });
});

describe("validateCompactionConfig", () => {
    it("returns undefined for nullish input", () => {
        assert.equal(validateCompactionConfig(undefined, "t"), undefined);
        assert.equal(validateCompactionConfig(null, "t"), undefined);
    });

    it("rejects non-object input", () => {
        assert.throws(() => validateCompactionConfig("not-an-object", "t"), /invalid compaction/);
        assert.throws(() => validateCompactionConfig([], "t"), /expected object/);
    });

    it("rejects invalid enabled type", () => {
        assert.throws(() => validateCompactionConfig({ enabled: "yes" }, "t"), /enabled.*boolean/);
    });

    it("rejects non-finite threshold", () => {
        assert.throws(
            () => validateCompactionConfig({ threshold: Number.NaN }, "t"),
            /finite number/,
        );
        assert.throws(
            () => validateCompactionConfig({ threshold: Number.POSITIVE_INFINITY }, "t"),
            /finite number/,
        );
    });

    it("rejects threshold outside the product clamp", () => {
        assert.throws(
            () => validateCompactionConfig({ threshold: 0.05 }, "t"),
            new RegExp(`${COMPACTION_THRESHOLD_MIN}.*${COMPACTION_THRESHOLD_MAX}`),
        );
        assert.throws(() => validateCompactionConfig({ threshold: 0.99 }, "t"), /must be in/);
    });

    it("applies default enabled when only threshold provided", () => {
        const r = validateCompactionConfig({ threshold: 0.5 }, "t");
        assert.deepEqual(r, { enabled: DEFAULT_COMPACTION_ENABLED, threshold: 0.5 });
    });

    it("applies default threshold when only enabled provided", () => {
        const r = validateCompactionConfig({ enabled: false }, "t");
        assert.deepEqual(r, { enabled: false, threshold: DEFAULT_COMPACTION_THRESHOLD });
    });

    it("accepts a full valid payload", () => {
        const r = validateCompactionConfig({ enabled: true, threshold: 0.8 }, "t");
        assert.deepEqual(r, { enabled: true, threshold: 0.8 });
    });
});

describe("mergeCompactionPatch", () => {
    const current = { enabled: true as boolean, threshold: 0.5 };

    it("returns current when patch is undefined or invalid", () => {
        assert.deepEqual(mergeCompactionPatch(current, undefined, "t"), current);
    });

    it("shallow-merges enabled overrides", () => {
        assert.deepEqual(mergeCompactionPatch(current, { enabled: false }, "t"), {
            enabled: false,
            threshold: 0.5,
        });
    });

    it("shallow-merges threshold without touching enabled", () => {
        assert.deepEqual(mergeCompactionPatch(current, { threshold: 0.8 }, "t"), {
            enabled: true,
            threshold: 0.8,
        });
    });

    it("rejects invalid enabled on patch", () => {
        assert.throws(
            () => mergeCompactionPatch(current, { enabled: "yes" as unknown as boolean }, "t"),
            /enabled.*boolean/,
        );
    });
});

describe("resolveConfig — compaction fallback chain", () => {
    useTempTacoHome("cfg-compaction");

    it("uses defaults when neither cli nor global is set", () => {
        const cfg = resolveConfig({});
        assert.equal(cfg.compaction.enabled, DEFAULT_COMPACTION_ENABLED);
        assert.equal(cfg.compaction.threshold, DEFAULT_COMPACTION_THRESHOLD);
    });

    it("global file overrides defaults", () => {
        saveGlobalConfig({ compaction: { enabled: false, threshold: 0.55 } });
        const cfg = resolveConfig({});
        assert.deepEqual(cfg.compaction, { enabled: false, threshold: 0.55 });
    });

    it("cli overrides global field-by-field", () => {
        saveGlobalConfig({ compaction: { enabled: true, threshold: 0.5 } });
        const cfg = resolveConfig({
            compaction: { threshold: 0.85 },
        });
        assert.deepEqual(cfg.compaction, { enabled: true, threshold: 0.85 });
    });

    it("rejects invalid threshold from cli", () => {
        assert.throws(() => resolveConfig({ compaction: { threshold: 2 } }), /must be in/);
    });

    it("readGlobalConfig round-trips a compaction patch", () => {
        saveGlobalConfig({ compaction: { enabled: true, threshold: 0.6 } });
        assert.deepEqual(readGlobalConfig().compaction, {
            enabled: true,
            threshold: 0.6,
        });
    });

    it("a later save is visible on the very next read (no cache)", () => {
        // Regression: readGlobalConfig itself is not cached — every call hits readFileSync,
        // which is required by RPC handlers (e.g. settings.get) that need the absolute-fresh value.
        // CompactionController.effectiveCompaction() adds an additional 1s TTL cache on top
        // to reduce steady-state IO; writes call invalidate() to force immediate re-read.
        saveGlobalConfig({ compaction: { threshold: 0.7 } });
        assert.equal(readGlobalConfig().compaction?.threshold, 0.7);
        saveGlobalConfig({ compaction: { threshold: 0.15 } });
        assert.equal(readGlobalConfig().compaction?.threshold, 0.15);
    });
});

describe("resolveConfig — memoryEnabled passthrough", () => {
    useTempTacoHome("cfg-mem");

    it("is undefined when not set (default = enabled)", () => {
        const cfg = resolveConfig({});
        assert.equal(cfg.memoryEnabled, undefined);
    });

    it("copies memoryEnabled: false from global config", () => {
        saveGlobalConfig({ memoryEnabled: false });
        assert.equal(resolveConfig({}).memoryEnabled, false);
    });

    it("cli override wins over global", () => {
        saveGlobalConfig({ memoryEnabled: false });
        assert.equal(resolveConfig({ memoryEnabled: true }).memoryEnabled, true);
    });
});
