import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { statPathTarget } from "../../src/tools/pathTarget.ts";

function fixture(t: TestContext): string {
    const dir = mkdtempSync(join(tmpdir(), "taco-path-target-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}

test("classifies a directory", async (t) => {
    const dir = fixture(t);
    assert.deepEqual(await statPathTarget(dir), { kind: "directory", root: dir });
});

test("classifies a file with its parent as search root", async (t) => {
    const dir = fixture(t);
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "one.ts"), "needle\n");
    assert.deepEqual(await statPathTarget(join(dir, "src", "one.ts")), {
        kind: "file",
        root: join(dir, "src"),
        name: "one.ts",
    });
});

test("rejects a missing path with an actionable message", async (t) => {
    const dir = fixture(t);
    await assert.rejects(statPathTarget(join(dir, "missing")), /path does not exist/);
});

test("rejects a non-directory non-file (FIFO) instead of treating it as a directory", async (t) => {
    const dir = fixture(t);
    const fifo = join(dir, "pipe");
    if (process.platform === "win32" || spawnSync("mkfifo", [fifo]).status !== 0) {
        t.skip("mkfifo unavailable");
        return;
    }
    await assert.rejects(statPathTarget(fifo), /not a regular file or directory/);
});

test("follows a symlink to a directory", async (t) => {
    const dir = fixture(t);
    mkdirSync(join(dir, "real"));
    symlinkSync(join(dir, "real"), join(dir, "link"));
    const target = await statPathTarget(join(dir, "link"));
    assert.equal(target.kind, "directory");
});

test("follows a symlink to a file", async (t) => {
    const dir = fixture(t);
    writeFileSync(join(dir, "real.ts"), "needle\n");
    symlinkSync(join(dir, "real.ts"), join(dir, "link.ts"));
    const target = await statPathTarget(join(dir, "link.ts"));
    assert.equal(target.kind, "file");
});

test("rejects a broken symlink as missing", async (t) => {
    const dir = fixture(t);
    symlinkSync(join(dir, "nope"), join(dir, "broken"));
    await assert.rejects(statPathTarget(join(dir, "broken")), /path does not exist/);
});
