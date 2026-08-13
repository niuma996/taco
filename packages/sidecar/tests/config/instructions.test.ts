/**
 * resolveInstructions — priority chain, file enable flags, override paths,
 * error isolation.
 *
 * Tests run against a temp cwd with no `$TACO_HOME` set — every fixture
 * creates only the directories it explicitly intends to populate so the
 * priority chain's later levels (user-taco, user-claude) don't pick up
 * stray files from a polluted environment.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { resolveInstructions } from "../../src/config/instructions.ts";

let prevTacoHome: string | undefined;
let userHomeDir: string;

before(() => {
    prevTacoHome = process.env.TACO_HOME;
    // Isolate the user-level lookup paths so the chain's "missing" baseline
    // is real (no leftover .taco/CLAUDE.md from the developer's machine).
    userHomeDir = mkdtempSync(join(tmpdir(), "taco-instructions-userhome-"));
    process.env.HOME = userHomeDir;
    process.env.USERPROFILE = userHomeDir;
    process.env.TACO_HOME = join(userHomeDir, ".taco");
});

after(() => {
    if (prevTacoHome === undefined) {
        Reflect.deleteProperty(process.env, "TACO_HOME");
    } else {
        process.env.TACO_HOME = prevTacoHome;
    }
    rmSync(userHomeDir, { recursive: true, force: true });
});

let cwd: string;
const prevTacoHomeFiles: string[] = [];
beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "taco-instructions-cwd-"));
    // Isolate both the user-taco fallback and the user-claude fallback so
    // prior tests don't leak files into the priority chain — a previous
    // test writing $TACO_HOME/CLAUDE.md or ~/.claude/CLAUDE.md would
    // otherwise be picked up here as a "user-taco" / "user-claude" block.
    const tacoHome = process.env.TACO_HOME;
    if (tacoHome) {
        try {
            rmSync(tacoHome, { recursive: true, force: true });
            mkdirSync(tacoHome, { recursive: true });
        } catch {
            // best-effort: chain still works without isolation
        }
    }
    try {
        rmSync(join(userHomeDir, ".claude"), { recursive: true, force: true });
    } catch {
        // best-effort
    }
    void prevTacoHomeFiles;
});

describe("resolveInstructions — enabled flag", () => {
    it("returns enabled=false and empty blocks when explicitly disabled", () => {
        writeFileSync(join(cwd, "CLAUDE.md"), "ignored");
        const out = resolveInstructions({
            cwd,
            config: { enabled: false, files: { claudeMd: true } },
        });
        assert.equal(out.enabled, false);
        assert.equal(out.blocks.length, 0);
    });

    it("defaults to enabled when config is omitted", () => {
        writeFileSync(join(cwd, "CLAUDE.md"), "ok");
        const out = resolveInstructions({ cwd });
        assert.equal(out.enabled, true);
    });
});

describe("resolveInstructions — priority chain", () => {
    it("prefers <cwd>/.taco/CLAUDE.md over <cwd>/CLAUDE.md", () => {
        mkdirSync(join(cwd, ".taco"));
        writeFileSync(join(cwd, ".taco", "CLAUDE.md"), "from-taco");
        writeFileSync(join(cwd, "CLAUDE.md"), "from-root");
        const out = resolveInstructions({ cwd, config: { enabled: true } });
        const claude = out.blocks.find((b) => b.name === "CLAUDE.md");
        assert.ok(claude);
        assert.equal(claude.content, "from-taco");
        assert.equal(claude.source, "project-taco");
    });

    it("falls back to <cwd>/CLAUDE.md when .taco variant is missing", () => {
        writeFileSync(join(cwd, "CLAUDE.md"), "from-root");
        const out = resolveInstructions({ cwd, config: { enabled: true } });
        const claude = out.blocks.find((b) => b.name === "CLAUDE.md");
        assert.ok(claude);
        assert.equal(claude.source, "project");
    });

    it("falls back to $TACO_HOME/CLAUDE.md when cwd has none", () => {
        const tacoHome = process.env.TACO_HOME;
        if (!tacoHome) throw new Error("TACO_HOME not set in test setup");
        mkdirSync(tacoHome, { recursive: true });
        writeFileSync(join(tacoHome, "CLAUDE.md"), "from-user-taco", "utf8");
        const out = resolveInstructions({ cwd, config: { enabled: true } });
        const claude = out.blocks.find((b) => b.name === "CLAUDE.md");
        assert.ok(claude);
        assert.equal(claude.source, "user-taco");
    });

    it("falls back to ~/.claude/CLAUDE.md only for CLAUDE.md", () => {
        // AGENTS.md skips ~/.claude/ even when that dir exists.
        mkdirSync(join(userHomeDir, ".claude"));
        writeFileSync(join(userHomeDir, ".claude", "CLAUDE.md"), "from-claude-home");
        writeFileSync(join(userHomeDir, ".claude", "AGENTS.md"), "should-not-resolve");
        const out = resolveInstructions({ cwd, config: { enabled: true } });
        const claude = out.blocks.find((b) => b.name === "CLAUDE.md");
        const agents = out.blocks.find((b) => b.name === "AGENTS.md");
        assert.ok(claude);
        assert.equal(claude.source, "user-claude");
        assert.equal(agents, undefined, "AGENTS.md must not look in ~/.claude/");
    });
});

describe("resolveInstructions — file enable flags", () => {
    it("skips files when explicitly disabled", () => {
        writeFileSync(join(cwd, "CLAUDE.md"), "x");
        writeFileSync(join(cwd, "AGENTS.md"), "y");
        const out = resolveInstructions({
            cwd,
            config: { enabled: true, files: { claudeMd: true, agentsMd: false } },
        });
        assert.ok(out.blocks.find((b) => b.name === "CLAUDE.md"));
        assert.equal(
            out.blocks.find((b) => b.name === "AGENTS.md"),
            undefined,
        );
    });

    it("DESIGN.md defaults to disabled when not specified", () => {
        writeFileSync(join(cwd, "DESIGN.md"), "design");
        const out = resolveInstructions({ cwd, config: { enabled: true } });
        assert.equal(
            out.blocks.find((b) => b.name === "DESIGN.md"),
            undefined,
        );
    });

    it("DESIGN.md can be opted in", () => {
        writeFileSync(join(cwd, "DESIGN.md"), "design");
        const out = resolveInstructions({
            cwd,
            config: { enabled: true, files: { designMd: true } },
        });
        assert.ok(out.blocks.find((b) => b.name === "DESIGN.md"));
    });
});

describe("resolveInstructions — override", () => {
    it("reads the override path directly, skipping the priority chain", () => {
        const overridePath = join(cwd, "docs", "AGENTS.md");
        mkdirSync(join(cwd, "docs"));
        writeFileSync(overridePath, "from-override");
        // Even though <cwd>/AGENTS.md exists at higher priority, the override
        // wins when explicitly set.
        writeFileSync(join(cwd, "AGENTS.md"), "from-root-should-be-ignored");
        const out = resolveInstructions({
            cwd,
            config: { enabled: true, filesOverride: { agentsMd: overridePath } },
        });
        const agents = out.blocks.find((b) => b.name === "AGENTS.md");
        assert.ok(agents);
        assert.equal(agents.source, "override");
        assert.equal(agents.content, "from-override");
    });

    it("override file missing → recorded as error, block omitted", () => {
        const out = resolveInstructions({
            cwd,
            config: {
                enabled: true,
                filesOverride: { claudeMd: join(cwd, "nope", "CLAUDE.md") },
            },
        });
        assert.equal(out.blocks.length, 0);
        assert.equal(out.errors.length, 1);
        assert.equal(out.errors[0]?.name, "CLAUDE.md");
    });
});

describe("resolveInstructions — error isolation", () => {
    it("one file's read failure does not block other files", () => {
        writeFileSync(join(cwd, "AGENTS.md"), "agents content");
        // Force a CLAUDE.md read failure via override (a path whose parent
        // doesn't exist) — chain lookup also fails, no parent dir creates.
        const out = resolveInstructions({
            cwd,
            config: {
                enabled: true,
                files: { claudeMd: true, agentsMd: true },
                filesOverride: { claudeMd: join(cwd, "no-such-dir", "CLAUDE.md") },
            },
        });
        // AGENTS.md still resolves; CLAUDE.md is recorded as error.
        assert.ok(out.blocks.find((b) => b.name === "AGENTS.md"));
        assert.equal(
            out.blocks.find((b) => b.name === "CLAUDE.md"),
            undefined,
        );
        assert.equal(out.errors.length, 1);
    });
});

describe("resolveInstructions — empty / whitespace files", () => {
    it("treats an empty file as missing (no block, no error)", () => {
        writeFileSync(join(cwd, "CLAUDE.md"), "");
        const out = resolveInstructions({ cwd, config: { enabled: true } });
        assert.equal(out.blocks.length, 0);
        assert.equal(out.errors.length, 0);
    });

    it("trims whitespace before content comparison", () => {
        writeFileSync(join(cwd, "CLAUDE.md"), "  \n  hello  \n  ");
        const out = resolveInstructions({ cwd, config: { enabled: true } });
        const claude = out.blocks.find((b) => b.name === "CLAUDE.md");
        assert.ok(claude);
        assert.equal(claude.content, "hello");
    });
});
