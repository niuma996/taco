import { strict as assert } from "node:assert";
import childProcess from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
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

function mockSpawn(
    t: TestContext,
    run: (
        args: string[],
        options: childProcess.SpawnOptions,
    ) => ReturnType<typeof childProcess.spawn>,
) {
    const mocked = t.mock.method(childProcess, "spawn", ((...received: unknown[]) => {
        const args = Array.isArray(received[1]) ? received[1].map(String) : [];
        return run(args, received[2] as childProcess.SpawnOptions);
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

test("fallback strips the carriage return of CRLF files so end anchors match", async (t) => {
    const { dir, env, tool } = await fixture(t);
    writeFileSync(join(dir, "crlf.txt"), "needle\r\nplain\r\n");
    const result = grepResult(await invokeTool(tool, { pattern: "needle$" }, { env }));
    assert.match(result.content[0].text, /crlf\.txt:1:needle/);
    assert.doesNotMatch(result.content[0].text, /\r/);
});

for (const ripgrep of [false, true]) {
    test(`${ripgrep ? "real ripgrep" : "fallback"} matches end anchors in CRLF and LF files`, async (t) => {
        if (ripgrep && realSpawnSync("rg", ["--version"]).status !== 0) {
            t.skip("ripgrep is not installed");
            return;
        }
        const { dir, env, tool } = await fixture(t, ripgrep);
        writeFileSync(join(dir, "mixed.txt"), "needle\r\nneedle\nplain\r\nneedle");
        const result = grepResult(await invokeTool(tool, { pattern: "^needle$" }, { env }));
        assert.equal(result.details.count, 3);
        assert.match(result.content[0].text, /mixed\.txt:1:needle/);
        assert.match(result.content[0].text, /mixed\.txt:2:needle/);
        assert.match(result.content[0].text, /mixed\.txt:4:needle/);
        assert.equal(result.details.truncated, false);
    });
}

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

test("ripgrep spawn failures include the search root alongside the errno", async (t) => {
    const { dir, env, tool } = await fixture(t, true);
    let ignorePath = "";
    mockSpawn(t, (args) => {
        ignorePath = args[args.indexOf("--ignore-file") + 1];
        return realSpawn(join(dir, "missing-rg"), []);
    });
    await assert.rejects(invokeTool(tool, { pattern: "needle" }, { env }), (error: Error) => {
        assert.match(error.message, /ENOENT/);
        assert.ok(error.message.includes(dir), `missing root in: ${error.message}`);
        return true;
    });
    assert.ok(ignorePath);
    assert.equal(existsSync(ignorePath), false);
});

test("ripgrep process failures report stderr and clean up the ignore file", async (t) => {
    const { env, tool } = await fixture(t, true);
    let ignorePath = "";
    mockSpawn(t, (args) => {
        ignorePath = args[args.indexOf("--ignore-file") + 1];
        return realSpawn(process.execPath, [
            "-e",
            "process.stdout.write('file.ts:1:partial'); process.stderr.write('search failed'); process.exitCode = 2;",
        ]);
    });
    await assert.rejects(invokeTool(tool, { pattern: "needle" }, { env }), /search failed/);
    assert.ok(ignorePath);
    assert.equal(existsSync(ignorePath), false);
});

test("ripgrep cancellation stops a partial record and cleans up the ignore file", async (t) => {
    const { env, tool } = await fixture(t, true);
    const controller = new AbortController();
    let ignorePath = "";
    let closed: Promise<void> | undefined;
    mockSpawn(t, (args, options) => {
        ignorePath = args[args.indexOf("--ignore-file") + 1];
        assert.equal(options.signal, controller.signal);
        const child = realSpawn(
            process.execPath,
            ["-e", "process.stdout.write('file.ts:1:partial'); setInterval(() => {}, 1000);"],
            { signal: options.signal },
        );
        t.after(() => child.kill());
        closed = new Promise((resolve) => child.once("close", () => resolve()));
        child.stdout?.once("data", () => controller.abort());
        return child;
    });
    await assert.rejects(
        invokeTool(tool, { pattern: "needle" }, { env }, { signal: controller.signal }),
        /abort/i,
    );
    await closed;
    assert.ok(ignorePath);
    assert.equal(existsSync(ignorePath), false);
});

test("ripgrep preserves standalone CR within LF-delimited matches", async (t) => {
    const { env, tool } = await fixture(t, true);
    const output = "file.ts:1:before\rneedle\r\n\nfile.ts:2:tail\r";
    mockSpawn(t, () =>
        realSpawn(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(output)})`]),
    );
    const result = grepResult(await invokeTool(tool, { pattern: "needle" }, { env }));
    assert.equal(result.content[0].text, "file.ts:1:before\rneedle\r\nfile.ts:2:tail\r");
    assert.equal(result.details.count, 2);
    assert.equal(result.details.truncated, false);
});

test("ripgrep preserves CR and UTF-8 across stream chunk boundaries", async (t) => {
    const { env, tool } = await fixture(t, true);
    const unicode = Buffer.from("🌮中");
    const chunks = [
        Buffer.from("file.ts:1:before\r"),
        Buffer.concat([Buffer.from("needle "), unicode.subarray(0, 1)]),
        unicode.subarray(1, 5),
        Buffer.concat([unicode.subarray(5), Buffer.from("\r")]),
        Buffer.from("\n\nfile.ts:2:tail"),
    ];
    mockSpawn(t, () => {
        const child = realSpawn(process.execPath, ["-e", ""]);
        Object.defineProperty(child, "stdout", { value: Readable.from(chunks) });
        return child;
    });
    const result = grepResult(await invokeTool(tool, { pattern: "needle" }, { env }));
    assert.equal(result.content[0].text, "file.ts:1:before\rneedle 🌮中\r\nfile.ts:2:tail");
    assert.equal(result.details.count, 2);
    assert.equal(result.details.truncated, false);
});

test("ripgrep clips a long record across chunks and counts its following record", async (t) => {
    const { env, tool } = await fixture(t, true);
    mockSpawn(t, () => {
        const child = realSpawn(process.execPath, ["-e", ""]);
        const chunks = async function* () {
            yield Buffer.from("file.ts:1:needle\r");
            for (let i = 0; i < 1024; i++) yield Buffer.alloc(16 * 1024, "x");
            yield Buffer.from("\nfile.ts:2:needle");
        };
        Object.defineProperty(child, "stdout", { value: Readable.from(chunks()) });
        return child;
    });
    const result = grepResult(await invokeTool(tool, { pattern: "needle" }, { env }));
    assert.equal(
        result.content[0].text,
        `${`file.ts:1:needle\r${"x".repeat(500)}`.slice(0, 500)}… [line clipped]\nfile.ts:2:needle`,
    );
    assert.equal(result.details.count, 2);
    assert.equal(result.details.truncated, true);
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

test("fallback searches a single file path, ignoring glob and gitignore", async (t) => {
    const { dir, env, tool } = await fixture(t);
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, ".gitignore"), "*.ts\n");
    writeFileSync(join(dir, "src", "one.ts"), "needle\n");
    writeFileSync(join(dir, "src", "two.ts"), "needle\n");
    const result = grepResult(
        await invokeTool(
            tool,
            { pattern: "needle", path: join(dir, "src", "one.ts"), glob: "*.md" },
            { env },
        ),
    );
    assert.equal(result.content[0].text, "one.ts:1:needle");
    assert.equal(result.details?.count, 1);
});

test("ripgrep searches a file from its parent directory with a filename prefix", async (t) => {
    const { dir, env, tool } = await fixture(t, true);
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "one.ts"), "needle\n");
    let received: string[] = [];
    let receivedCwd = "";
    mockSpawn(t, (args, options) => {
        received = args;
        receivedCwd = String(options.cwd);
        return realSpawn(process.execPath, ["-e", "process.stdout.write('one.ts:1:needle\\n')"]);
    });
    const result = grepResult(
        await invokeTool(
            tool,
            { pattern: "needle", path: join(dir, "src", "one.ts"), glob: "*.md" },
            { env },
        ),
    );
    assert.equal(receivedCwd, join(dir, "src"));
    assert.ok(received.includes("--with-filename"));
    assert.equal(received.at(-2), "needle");
    assert.equal(received.at(-1), "one.ts");
    assert.ok(!received.includes("--glob"));
    assert.equal(result.content[0].text, "one.ts:1:needle");
});

test("real ripgrep prefixes the filename when searching a single file", async (t) => {
    if (realSpawnSync("rg", ["--version"]).status !== 0) {
        t.skip("ripgrep is not installed");
        return;
    }
    const { dir, env, spawn, tool } = await fixture(t, true);
    spawn.mock.mockImplementation(realSpawnSync);
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "one.ts"), "needle\n");
    writeFileSync(join(dir, "src", "two.ts"), "needle\n");
    const result = grepResult(
        await invokeTool(tool, { pattern: "needle", path: join(dir, "src", "one.ts") }, { env }),
    );
    assert.equal(result.content[0].text, "one.ts:1:needle");
    assert.equal(result.details?.count, 1);
});

for (const ripgrep of [false, true]) {
    test(`${ripgrep ? "ripgrep" : "fallback"} rejects a search path that does not exist`, async (t) => {
        const { dir, env, tool } = await fixture(t, ripgrep);
        await assert.rejects(
            invokeTool(tool, { pattern: "needle", path: join(dir, "missing") }, { env }),
            /path does not exist/,
        );
    });
}
