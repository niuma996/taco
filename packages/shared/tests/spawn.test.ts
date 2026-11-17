import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createDefaultSidecarSpawn } from "../spawn.js";

function platform(t: TestContext, value: NodeJS.Platform) {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
    assert.ok(descriptor);
    Object.defineProperty(process, "platform", { ...descriptor, value });
    t.after(() => Object.defineProperty(process, "platform", descriptor));
    for (const key of ["TACO_SIDECAR_CMD", "TACO_SIDECAR_ARGS", "TACO_SIDECAR_CWD"]) {
        const previous = process.env[key];
        delete process.env[key];
        t.after(() => {
            if (previous === undefined) delete process.env[key];
            else process.env[key] = previous;
        });
    }
}

test("Windows dev spawn loads TypeScript outside the repo with spaces in the path", (t) => {
    platform(t, "win32");
    const cwd = mkdtempSync(join(tmpdir(), "taco spawn # "));
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    const entry = join(cwd, "entry.ts");
    writeFileSync(entry, 'const value: string = "loaded"; console.log(value);');
    const { spawn } = createDefaultSidecarSpawn({ repoRoot: cwd });
    assert.equal(spawn.command, process.execPath);
    assert.equal(spawn.args[0], "--import");
    assert.equal(spawn.args[2], "packages/sidecar/src/index.ts");
    const result = spawnSync(spawn.command, [...spawn.args.slice(0, 2), entry], {
        cwd: spawn.cwd,
        env: spawn.env,
        encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "loaded");
    assert.ok(spawn.args[1].startsWith("file:"));
    assert.ok(existsSync(fileURLToPath(spawn.args[1])));
});

test("Windows explicit command and argv bypass loader inference", (t) => {
    platform(t, "win32");
    const cwd = resolve("custom checkout");
    const { spawn } = createDefaultSidecarSpawn({
        command: "custom-sidecar.exe",
        args: ["entry with spaces.js"],
        repoRoot: cwd,
        env: { TACO_SPAWN_TEST: "override" },
    });
    assert.equal(spawn.command, "custom-sidecar.exe");
    assert.deepEqual(spawn.args, ["entry with spaces.js"]);
    assert.equal(spawn.cwd, cwd);
    assert.equal(spawn.env.TACO_SPAWN_TEST, "override");
});

test("Windows environment command overrides the default Node launcher", (t) => {
    platform(t, "win32");
    process.env.TACO_SIDECAR_CMD = "custom-sidecar.exe";
    process.env.TACO_SIDECAR_ARGS = "--stdio entry.js";
    const { spawn } = createDefaultSidecarSpawn();
    assert.equal(spawn.command, "custom-sidecar.exe");
    assert.deepEqual(spawn.args, ["--stdio", "entry.js"]);
});

for (const name of ["darwin", "linux"] as const) {
    test(`${name} keeps the existing tsx command and arguments`, (t) => {
        platform(t, name);
        const { spawn } = createDefaultSidecarSpawn();
        assert.equal(spawn.command, "tsx");
        assert.deepEqual(spawn.args, ["packages/sidecar/src/index.ts"]);
    });
}
