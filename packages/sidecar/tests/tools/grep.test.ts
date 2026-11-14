import { strict as assert } from "node:assert";
import childProcess from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { NodeExecutionEnv } from "../../src/runtime/pi/node.ts";
import { invokeTool } from "../_helpers/invokeTool.ts";

const realSpawnSync = childProcess.spawnSync;
const realSpawn = childProcess.spawn;
let moduleId = 0;

type GrepResult = {
    content: Array<{ type: string; text: string }>;
    details: { count: number; truncated: boolean };
};

function grepResult(value: unknown): GrepResult {
    return value as GrepResult;
}

function mockSpawn(t: TestContext, run: (args: string[]) => ReturnType<typeof childProcess.spawn>) {
    const mocked = t.mock.method(childProcess, "spawn", ((...received: unknown[]) => {
        const args = Array.isArray(received[1]) ? received[1].map(String) : [];
        return run(args);
    }) as typeof childProcess.spawn);
    syncBuiltinESMExports();
    t.after(() => {
        mocked.mock.restore();
        syncBuiltinESMExports();
    });
}

async function fixture(t: TestContext, ripgrep = false) {
    const dir = mkdtempSync(join(tmpdir(), "taco-grep-regression-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const spawn = t.mock.method(childProcess, "spawnSync", ((..._args: unknown[]) => ({
        status: ripgrep ? 0 : 1,
    })) as typeof childProcess.spawnSync);
    syncBuiltinESMExports();
    t.after(() => {
        spawn.mock.restore();
        syncBuiltinESMExports();
    });
    const { createGrepTool } = await import(`../../src/tools/grep.ts?regression=${moduleId++}`);
    const env = new NodeExecutionEnv({ cwd: dir });
    return { dir, env, spawn, tool: createGrepTool() };
}

test("fallback matches basename globs in subdirectories and honors ignore rules", async (t) => {
    const { dir, env, tool } = await fixture(t);
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "src", "deep.ts"), "needle\n");
    writeFileSync(join(dir, "src", "skip.ts"), "needle\n");
    writeFileSync(join(dir, "node_modules", "dep.ts"), "needle\n");
    writeFileSync(join(dir, ".gitignore"), "src/skip.ts\n");
    const result = grepResult(await invokeTool(tool, { pattern: "needle", glob: "*.ts" }, { env }));
    assert.match(result.content[0].text, /src\/deep.ts:1:needle/);
    assert.doesNotMatch(result.content[0].text, /skip.ts|dep.ts/);
});

test("fallback skips NUL and invalid UTF-8 files instead of matching decoded binary", async (t) => {
    const { dir, env, tool } = await fixture(t);
    writeFileSync(join(dir, "nul.bin"), "needle\0payload");
    writeFileSync(join(dir, "invalid.bin"), Buffer.from([110, 101, 101, 100, 108, 101, 255]));
    writeFileSync(join(dir, "text.txt"), "needle\n");
    const result = grepResult(await invokeTool(tool, { pattern: "needle" }, { env }));
    assert.match(result.content[0].text, /text.txt:1:needle/);
    assert.doesNotMatch(result.content[0].text, /nul.bin|invalid.bin/);
});

test("fallback skips files over 2 MiB and reports an incomplete search", async (t) => {
    const { dir, env, tool } = await fixture(t);
    writeFileSync(join(dir, "large.txt"), `needle${"x".repeat(2 * 1024 * 1024)}`);
    writeFileSync(join(dir, "small.txt"), "needle\n");
    const result = grepResult(await invokeTool(tool, { pattern: "needle" }, { env }));
    assert.match(result.content[0].text, /small.txt:1:needle/);
    assert.doesNotMatch(result.content[0].text, /large.txt:1:/);
    assert.match(result.content[0].text, /skipped.*2 MiB/i);
    assert.equal(result.details?.truncated, true);
});

test("fallback counts all matches while retaining bounded output", async (t) => {
    const { dir, env, tool } = await fixture(t);
    writeFileSync(join(dir, "many.txt"), `needle ${"x".repeat(1000)}\n`.repeat(1000));
    const result = grepResult(await invokeTool(tool, { pattern: "needle" }, { env }));
    assert.equal(result.details?.count, 1000);
    assert.equal(result.details?.truncated, true);
    assert.ok(result.content[0].text.length < 51_000);
});

test("ripgrep reads ignore rules from a portable temporary file and cleans it up", async (t) => {
    const { dir, env, tool } = await fixture(t, true);
    writeFileSync(join(dir, ".gitignore"), "secret/\n");
    let ignorePath = "";
    mockSpawn(t, (args) => {
        ignorePath = args[args.indexOf("--ignore-file") + 1];
        assert.notEqual(ignorePath, "/dev/stdin");
        assert.match(readFileSync(ignorePath, "utf8"), /secret\//);
        return realSpawn(process.execPath, ["-e", "process.stdout.write('file.ts:1:needle\\n')"]);
    });
    const result = grepResult(await invokeTool(tool, { pattern: "needle" }, { env }));
    assert.match(result.content[0].text, /file.ts:1:needle/);
    assert.ok(ignorePath);
    assert.equal(existsSync(ignorePath), false);
});

test("ripgrep spawn failures surface as errors instead of no matches", async (t) => {
    const { dir, env, tool } = await fixture(t, true);
    let ignorePath = "";
    mockSpawn(t, (args) => {
        ignorePath = args[args.indexOf("--ignore-file") + 1];
        return realSpawn(join(dir, "missing-rg"), []);
    });
    await assert.rejects(invokeTool(tool, { pattern: "needle" }, { env }), /ENOENT/);
    assert.ok(ignorePath);
    assert.equal(existsSync(ignorePath), false);
});

test("ripgrep streams more than 8 MiB of matches without losing its bounded result", async (t) => {
    if (realSpawnSync("rg", ["--version"]).status !== 0) {
        t.skip("ripgrep is not installed");
        return;
    }
    const { dir, env, spawn, tool } = await fixture(t, true);
    spawn.mock.mockImplementation(realSpawnSync);
    const rows = `needle ${"x".repeat(400)}\n`.repeat(1000);
    for (let i = 0; i < 24; i++) writeFileSync(join(dir, `${i}.txt`), rows);
    const result = grepResult(await invokeTool(tool, { pattern: "needle" }, { env }));
    assert.equal(result.details.count, 24_000);
    assert.equal(result.details.truncated, true);
    assert.ok(result.content[0].text.length < 51_000);
});

test("ripgrep continues searching files over 2 MiB", async (t) => {
    if (realSpawnSync("rg", ["--version"]).status !== 0) {
        t.skip("ripgrep is not installed");
        return;
    }
    const { dir, env, spawn, tool } = await fixture(t, true);
    spawn.mock.mockImplementation(realSpawnSync);
    writeFileSync(join(dir, "large.txt"), `${"x\n".repeat(1024 * 1024)}needle\n`);
    const result = grepResult(await invokeTool(tool, { pattern: "needle" }, { env }));
    assert.match(result.content[0].text, /large.txt:1048577:needle/);
    assert.equal(result.details.count, 1);
    assert.equal(result.details.truncated, false);
});

test("real ripgrep honors anchored ignore rules with a temporary ignore file", async (t) => {
    if (realSpawnSync("rg", ["--version"]).status !== 0) {
        t.skip("ripgrep is not installed");
        return;
    }
    const { dir, env, spawn, tool } = await fixture(t, true);
    spawn.mock.mockImplementation(realSpawnSync);
    mkdirSync(join(dir, "secret"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, ".gitignore"), "/secret/\n");
    writeFileSync(join(dir, "secret", "hidden.ts"), "-needle\n");
    writeFileSync(join(dir, "src", "visible.ts"), "-needle\n");
    const result = grepResult(
        await invokeTool(tool, { pattern: "-needle", glob: "*.ts" }, { env }),
    );
    assert.match(result.content[0].text, /src\/visible.ts:1:-needle/);
    assert.doesNotMatch(result.content[0].text, /hidden.ts/);
});
