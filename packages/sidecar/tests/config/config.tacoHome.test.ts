/**
 * Validates tacoHome() — the root of taco-owned paths.
 *
 * Hermetic: each case explicitly saves/restores TACO_HOME / PI_AGENT_DIR so no env is leaked.
 *
 * Run: cd packages/sidecar && pnpm exec tsx --test tests/config/config.tacoHome.test.ts
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { defaultSessionsRoot, defaultSkillDirs, tacoHome } from "../../src/config/config.ts";

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

    it("ignores PI_AGENT_DIR", () => {
        const tmp = mkdtempSync(join(tmpdir(), "pi-agent-"));
        process.env.PI_AGENT_DIR = tmp;
        Reflect.deleteProperty(process.env, "TACO_HOME");
        try {
            // Key: PI_AGENT_DIR does not affect taco, even when set.
            assert.equal(tacoHome(), resolve(homedir(), ".taco"));
        } finally {
            rmSync(tmp, { recursive: true, force: true });
            Reflect.deleteProperty(process.env, "PI_AGENT_DIR");
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
