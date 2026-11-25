import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs, {
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { readGlobalConfig, resolveConfig, saveGlobalConfig } from "../../src/config/config.ts";
import { createChannelControl } from "../../src/server/channelControl.ts";

const mcpUrl = new URL("../../src/server/handlers/mcp.ts", import.meta.url).href;
const callUrl = new URL("../_helpers/handlerCall.ts", import.meta.url).href;
const channelUrl = new URL("../../src/server/channelControl.ts", import.meta.url).href;
const configUrl = new URL("../../src/config/config.ts", import.meta.url).href;
const configStoreUrl = new URL("../../src/config/configStore.ts", import.meta.url).href;
const resolveHooksUrl = new URL("../_helpers/tsResolveHooks.ts", import.meta.url).href;
// Native type stripping instead of tsx: these workers spawn child processes and
// tsx's startup dominated the whole test file.
const tsFlags = ["--experimental-transform-types", "--import", resolveHooksUrl];
const RESULT_PREFIX = "__case_result__";

function worker(home: string, source: string) {
    const child = spawn(process.execPath, [...tsFlags, "--input-type=module", "-e", source], {
        env: { ...process.env, TACO_HOME: home },
        stdio: ["pipe", "pipe", "pipe"],
    });
    let errors = "";
    child.stderr.setEncoding("utf8").on("data", (data: string) => {
        errors += data;
    });
    const done = once(child, "exit").then(([code]) => {
        assert.equal(code, 0, errors);
    });
    return { child, done };
}

/** A dead child stays visible to `process.kill(pid, 0)` until it is reaped. */
async function waitUntilReaped(pid: number): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt++) {
        try {
            process.kill(pid, 0);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
            throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`process ${pid} was never reaped`);
}

type FixtureResult = {
    errors: string[];
    config?: Record<string, unknown>;
    homeEntries: string[];
    lockEntries: string[];
    pid: number;
    livePid?: number;
    provider?: string;
    model?: string;
};

/**
 * Runs a lock fixture in its own process and home directory.
 *
 * Every fixture blocks for the full lock timeout when it expects one, so they
 * run concurrently instead of one after another.
 */
async function runFixture(source: string, home: string): Promise<FixtureResult> {
    const child = spawn(process.execPath, [...tsFlags, "--input-type=module", "-e", source], {
        env: { ...process.env, TACO_HOME: home },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let errors = "";
    child.stdout.setEncoding("utf8").on("data", (data: string) => {
        out += data;
    });
    child.stderr.setEncoding("utf8").on("data", (data: string) => {
        errors += data;
    });
    const [code] = await once(child, "exit");
    assert.equal(code, 0, errors);
    const line = out.split("\n").find((entry) => entry.startsWith(RESULT_PREFIX));
    assert.ok(line, `fixture produced no result: ${out}\n${errors}`);
    return JSON.parse(line.slice(RESULT_PREFIX.length)) as FixtureResult;
}

const fixtureScripts = {
    // A lock owned by a live process must never be stolen.
    "live-owner": `
        import { spawn } from "node:child_process";
        import { once } from "node:events";
        import fs from "node:fs";
        import { join } from "node:path";
        import { saveGlobalConfig } from ${JSON.stringify(configUrl)};
        const home = process.env.TACO_HOME;
        saveGlobalConfig({ defaultModel: "kept" });
        const alive = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { stdio: "ignore" });
        await once(alive, "spawn");
        const lock = join(home, "taco.json.lock");
        fs.mkdirSync(lock);
        fs.writeFileSync(join(lock, alive.pid + "-live-owner"), "");
        const errors = [];
        try { saveGlobalConfig({ defaultModel: "lost" }); } catch (error) { errors.push(String(error.message)); }
        const config = JSON.parse(fs.readFileSync(join(home, "taco.json"), "utf8"));
        const lockEntries = fs.readdirSync(lock);
        alive.kill();
        console.log(${JSON.stringify(RESULT_PREFIX)} + JSON.stringify({ errors, config, homeEntries: fs.readdirSync(home), lockEntries, pid: process.pid, livePid: alive.pid }));
    `,
    // A token left behind by a previous process that reused this PID is reclaimable.
    "reused-pid": `
        import fs from "node:fs";
        import { join } from "node:path";
        import { readGlobalConfig, saveGlobalConfig } from ${JSON.stringify(configUrl)};
        const home = process.env.TACO_HOME;
        saveGlobalConfig({ defaultModel: "kept" });
        const lock = join(home, "taco.json.lock");
        fs.mkdirSync(lock);
        fs.writeFileSync(join(lock, process.pid + "-reused-pid"), "");
        const errors = [];
        try { saveGlobalConfig({ defaultModel: "recovered" }); } catch (error) { errors.push(String(error.message)); }
        console.log(${JSON.stringify(RESULT_PREFIX)} + JSON.stringify({ errors, config: readGlobalConfig(), homeEntries: fs.readdirSync(home), lockEntries: fs.existsSync(lock) ? fs.readdirSync(lock) : [], pid: process.pid }));
    `,
    // A lock owned by a dead process is reclaimable, and the reclaim touches only its own token.
    "dead-owner": `
        import { spawn } from "node:child_process";
        import { once } from "node:events";
        import fs from "node:fs";
        import { join } from "node:path";
        import { saveGlobalConfig } from ${JSON.stringify(configUrl)};
        const home = process.env.TACO_HOME;
        const dead = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
        await once(dead, "exit");
        let reaped = false;
        for (let attempt = 0; attempt < 200; attempt++) {
            try { process.kill(dead.pid, 0); } catch (error) { if (error.code === "ESRCH") { reaped = true; break; } throw error; }
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        if (!reaped) throw new Error("dead owner was never reaped");
        const lock = join(home, "taco.json.lock");
        fs.mkdirSync(lock);
        fs.writeFileSync(join(lock, dead.pid + "-dead-owner"), "");
        saveGlobalConfig({ defaultModel: "recovered" });
        const homeEntries = fs.readdirSync(home);
        saveGlobalConfig({ get defaultProvider() {
            fs.rmSync(lock, { recursive: true, force: true });
            fs.mkdirSync(lock);
            fs.writeFileSync(join(lock, process.pid + "-replacement"), "");
            return "next";
        }});
        console.log(${JSON.stringify(RESULT_PREFIX)} + JSON.stringify({ errors: [], homeEntries, lockEntries: fs.readdirSync(lock), pid: process.pid }));
    `,
    // A transaction nested in the same process must not wait forever.
    reentrant: `
        import fs from "node:fs";
        import { saveGlobalConfig } from ${JSON.stringify(configUrl)};
        const errors = [];
        try {
            saveGlobalConfig({ get defaultModel() { saveGlobalConfig({ defaultProvider: "nested" }); return "outer"; } });
        } catch (error) { errors.push(String(error.message)); }
        console.log(${JSON.stringify(RESULT_PREFIX)} + JSON.stringify({ errors, homeEntries: fs.readdirSync(process.env.TACO_HOME), lockEntries: [], pid: process.pid }));
    `,
    // Two store instances share one lock; the rejected mutation must release it.
    "multi-store": `
        import { join } from "node:path";
        import { ConfigStore } from ${JSON.stringify(configStoreUrl)};
        const path = join(process.env.TACO_HOME, "taco.json");
        const first = new ConfigStore();
        const second = new ConfigStore();
        first.update(path, () => ({ defaultModel: "kept" }));
        const errors = [];
        try { first.update(path, () => second.update(path, () => ({}))); } catch (error) { errors.push(String(error.message)); }
        second.update(path, (current) => ({ ...current, defaultProvider: "next" }));
        console.log(${JSON.stringify(RESULT_PREFIX)} + JSON.stringify({ errors, provider: first.read(path).defaultProvider, model: first.read(path).defaultModel, homeEntries: [], lockEntries: [], pid: process.pid }));
    `,
    // EACCES on the lock rename is contention only while the lock really exists.
    eacces: `
        import { spawn } from "node:child_process";
        import { once } from "node:events";
        import fs from "node:fs";
        import { syncBuiltinESMExports } from "node:module";
        import { join } from "node:path";
        import { saveGlobalConfig } from ${JSON.stringify(configUrl)};
        const home = process.env.TACO_HOME;
        const realRename = fs.renameSync;
        fs.renameSync = (...args) => {
            if (String(args[1]).endsWith(".lock")) throw Object.assign(new Error("access denied"), { code: "EACCES" });
            return realRename(...args);
        };
        syncBuiltinESMExports();
        const errors = [];
        try { saveGlobalConfig({}); } catch (error) { errors.push(String(error.message)); }
        const alive = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { stdio: "ignore" });
        await once(alive, "spawn");
        const lock = join(home, "taco.json.lock");
        fs.mkdirSync(lock);
        fs.writeFileSync(join(lock, alive.pid + "-live"), "");
        try { saveGlobalConfig({}); } catch (error) { errors.push(String(error.message)); }
        fs.renameSync = realRename;
        syncBuiltinESMExports();
        alive.kill();
        console.log(${JSON.stringify(RESULT_PREFIX)} + JSON.stringify({ errors, homeEntries: fs.readdirSync(home), lockEntries: fs.existsSync(lock) ? fs.readdirSync(lock) : [], pid: process.pid, livePid: alive.pid }));
    `,
};

type ContentionCase = {
    name: string;
    lockFixture: keyof typeof fixtureScripts;
    expectedError?: RegExp;
    expectedDirContents?: (result: FixtureResult) => string[];
    observedDir?: "home" | "lock";
    check?: (result: FixtureResult) => void;
};

const contentionCases: ContentionCase[] = [
    {
        name: "bounds contention without stealing a live process lock",
        lockFixture: "live-owner",
        expectedError: /timed out.*taco\.json\.lock/i,
        expectedDirContents: (result) => [`${result.livePid}-live-owner`],
        observedDir: "lock",
        check: (result) => {
            assert.equal(result.errors.length, 1);
            assert.equal(result.config?.defaultModel, "kept");
        },
    },
    {
        name: "reclaims a same-process lock left by a reused PID",
        lockFixture: "reused-pid",
        expectedDirContents: () => ["taco.json"],
        observedDir: "home",
        check: (result) => {
            assert.equal(result.config?.defaultModel, "recovered");
        },
    },
    {
        name: "recovers a dead process lock and removes only its own owner token",
        lockFixture: "dead-owner",
        expectedDirContents: () => ["taco.json"],
        observedDir: "home",
        check: (result) => {
            assert.deepEqual(result.lockEntries, [`${result.pid}-replacement`]);
        },
    },
    {
        name: "bounds reentrant transactions from the same process",
        lockFixture: "reentrant",
        expectedError: /timed out.*config lock/i,
        expectedDirContents: () => [],
        observedDir: "home",
    },
    {
        name: "coordinates multiple store instances and releases after a rejected mutation",
        lockFixture: "multi-store",
        expectedError: /timed out/i,
        check: (result) => {
            assert.equal(result.provider, "next");
            assert.equal(result.model, "kept");
        },
    },
    {
        name: "handles EACCES as contention only when the lock exists",
        lockFixture: "eacces",
        expectedError: /access denied/,
        check: (result) => {
            assert.equal(result.errors.length, 2);
            assert.match(result.errors[1], /timed out.*config lock/i);
        },
    },
];

describe("global config transactions", () => {
    let home: string;
    let previous: string | undefined;
    beforeEach(() => {
        previous = process.env.TACO_HOME;
        home = mkdtempSync(join(tmpdir(), "taco-config-transactions-"));
        process.env.TACO_HOME = home;
    });
    afterEach(() => {
        if (previous === undefined) Reflect.deleteProperty(process.env, "TACO_HOME");
        else process.env.TACO_HOME = previous;
        rmSync(home, { recursive: true, force: true });
    });

    it("merges independent patches from competing processes without losing keys", async () => {
        saveGlobalConfig({ apiKeys: { initial: "kept" } });
        const workers = Array.from({ length: 2 }, (_, id) =>
            worker(
                home,
                `
            import { saveGlobalConfig } from ${JSON.stringify(configUrl)};
            process.stdout.write('ready');
            await new Promise(resolve => process.stdin.once('data', resolve));
            for (let n = 0; n < 4; n++) {
                saveGlobalConfig({ get apiKeys() {
                    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 12);
                    return { ['worker-${id}-' + n]: 'kept' };
                }});
            }
            process.stdin.destroy();
        `,
            ),
        );
        await Promise.all(workers.map(({ child }) => once(child.stdout, "data")));
        for (const { child } of workers) child.stdin.end("go");
        await Promise.all(workers.map(({ done }) => done));
        const stored = JSON.parse(readFileSync(join(home, "taco.json"), "utf8"));
        assert.equal(Object.keys(stored.apiKeys).length, 9);
        assert.equal(stored.apiKeys.initial, "kept");
        for (let id = 0; id < 2; id++) {
            for (let n = 0; n < 4; n++) {
                assert.equal(stored.apiKeys[`worker-${id}-${n}`], "kept");
            }
        }
    });

    it("refreshes a warm cache after another process writes", async () => {
        saveGlobalConfig({ defaultModel: "before" });
        assert.equal(readGlobalConfig().defaultModel, "before");
        await worker(
            home,
            `
            import { saveGlobalConfig } from ${JSON.stringify(configUrl)};
            saveGlobalConfig({ defaultModel: 'after' });
        `,
        ).done;
        assert.equal(readGlobalConfig().defaultModel, "after");
    });

    it("refreshes after deletion, external atomic replacement, corruption and repair", () => {
        saveGlobalConfig({ defaultModel: "before" });
        readGlobalConfig();
        const path = join(home, "taco.json");
        rmSync(path);
        assert.deepEqual(readGlobalConfig(), {});
        writeFileSync(`${path}.replacement`, '{"defaultModel":"after"}');
        renameSync(`${path}.replacement`, path);
        assert.equal(readGlobalConfig().defaultModel, "after");
        writeFileSync(path, "{broken");
        assert.throws(() => readGlobalConfig());
        writeFileSync(path, '{"defaultModel":"fixed"}');
        assert.equal(readGlobalConfig().defaultModel, "fixed");
    });

    it("handles lock contention, dead owners, reentrancy and EACCES", async () => {
        const homes = contentionCases.map(() =>
            mkdtempSync(join(tmpdir(), "taco-config-contention-")),
        );
        try {
            const results = await Promise.all(
                contentionCases.map((contentionCase, index) =>
                    runFixture(fixtureScripts[contentionCase.lockFixture], homes[index]),
                ),
            );
            for (const [index, contentionCase] of contentionCases.entries()) {
                const result = results[index];
                if (contentionCase.expectedError) {
                    assert.match(
                        result.errors[0] ?? "",
                        contentionCase.expectedError,
                        `${contentionCase.name}: unexpected error`,
                    );
                } else {
                    assert.deepEqual(
                        result.errors,
                        [],
                        `${contentionCase.name}: expected no error`,
                    );
                }
                if (contentionCase.expectedDirContents) {
                    const entries =
                        contentionCase.observedDir === "home"
                            ? result.homeEntries
                            : result.lockEntries;
                    assert.deepEqual(
                        entries,
                        contentionCase.expectedDirContents(result),
                        `${contentionCase.name}: unexpected directory contents`,
                    );
                }
                contentionCase.check?.(result);
            }
        } finally {
            for (const caseHome of homes) rmSync(caseHome, { recursive: true, force: true });
        }
    });

    it("treats only missing files as unconfigured and refuses to overwrite empty files", () => {
        assert.deepEqual(readGlobalConfig(), {});
        const path = join(home, "taco.json");
        writeFileSync(path, "");
        assert.throws(() => readGlobalConfig(), SyntaxError);
        assert.throws(() => saveGlobalConfig({ defaultModel: "lost" }), SyntaxError);
        assert.equal(readFileSync(path, "utf8"), "");
        rmSync(path);
        mkdirSync(path);
        assert.throws(() => readGlobalConfig());
        assert.throws(() => saveGlobalConfig({ defaultModel: "lost" }));
        assert.deepEqual(readdirSync(home), ["taco.json"]);
    });

    for (const failure of ["write", "rename"] as const) {
        it(`keeps the old file and cleans temporary files after ${failure} failure`, () => {
            saveGlobalConfig({ defaultModel: "kept" });
            const path = join(home, "taco.json");
            const before = readFileSync(path, "utf8");
            readGlobalConfig();
            const realWrite = fs.writeFileSync;
            const realRename = fs.renameSync;
            if (failure === "write") {
                mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
                    if (String(args[0]).includes(".tmp-")) {
                        realWrite(args[0], "partial", args[2]);
                        throw new Error("injected write failure");
                    }
                    return realWrite(...args);
                });
            } else {
                mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
                    if (String(args[0]).includes(".tmp-"))
                        throw new Error("injected rename failure");
                    return realRename(...args);
                });
            }
            syncBuiltinESMExports();
            try {
                assert.throws(() => saveGlobalConfig({ defaultModel: "lost" }), /injected/);
                assert.equal(readFileSync(path, "utf8"), before);
                assert.deepEqual(readdirSync(home), ["taco.json"]);
                assert.equal(readGlobalConfig().defaultModel, "kept");
            } finally {
                mock.restoreAll();
                syncBuiltinESMExports();
            }
            saveGlobalConfig({ defaultProvider: "next" });
        });
    }

    it("recovers an empty lock directory when Windows refuses replacing directories", () => {
        const lock = join(home, "taco.json.lock");
        mkdirSync(lock);
        const realRename = fs.renameSync;
        mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
            if (String(args[1]) === lock && fs.existsSync(lock)) {
                throw Object.assign(new Error("access denied"), { code: "EACCES" });
            }
            return realRename(...args);
        });
        syncBuiltinESMExports();
        try {
            saveGlobalConfig({ defaultModel: "recovered-empty-lock" });
            assert.equal(readGlobalConfig().defaultModel, "recovered-empty-lock");
        } finally {
            mock.restoreAll();
            syncBuiltinESMExports();
        }
    });

    it("derives MCP collection additions inside the cross-process transaction", async () => {
        const workers = Array.from({ length: 2 }, (_, id) =>
            worker(
                home,
                `
            import { registerMcpHandlers } from ${JSON.stringify(mcpUrl)};
            import { callMethod } from ${JSON.stringify(callUrl)};
            registerMcpHandlers();
            process.stdout.write('ready');
            await new Promise(resolve => process.stdin.once('data', resolve));
            for (let n = 0; n < 2; n++) {
                await callMethod('mcp.createConfig', { params: { get config() {
                    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 12);
                    return { id: 'mcp-${id}-' + n, transport: 'stdio', command: 'node' };
                }}});
            }
            process.stdin.destroy();
        `,
            ),
        );
        await Promise.all(workers.map(({ child }) => once(child.stdout, "data")));
        for (const { child } of workers) child.stdin.end("go");
        await Promise.all(workers.map(({ done }) => done));
        assert.equal(readGlobalConfig().mcpServers?.length, 4);
    });

    it("derives channel additions from locked disk state despite warm process caches", async () => {
        saveGlobalConfig({ channels: [] });
        const workers = Array.from({ length: 2 }, (_, id) =>
            worker(
                home,
                `
            import { readGlobalConfig } from ${JSON.stringify(configUrl)};
            import { createChannelControl } from ${JSON.stringify(channelUrl)};
            readGlobalConfig();
            const control = createChannelControl({ getChannelConfigs: () => [] });
            process.stdout.write('ready');
            await new Promise(resolve => process.stdin.once('data', resolve));
            for (let n = 0; n < 4; n++) control.channels.create('wechat', 'wechat-${id}-' + n);
            process.stdin.destroy();
        `,
            ),
        );
        await Promise.all(workers.map(({ child }) => once(child.stdout, "data")));
        for (const { child } of workers) child.stdin.end("go");
        await Promise.all(workers.map(({ done }) => done));
        assert.equal(readGlobalConfig().channels?.length, 8);
    });

    it("recovers after a writer process dies while holding the lock", async () => {
        saveGlobalConfig({ defaultModel: "kept" });
        const child = spawn(
            process.execPath,
            [
                ...tsFlags,
                "--input-type=module",
                "-e",
                `
            import { saveGlobalConfig } from ${JSON.stringify(configUrl)};
            saveGlobalConfig({ get defaultModel() {
                process.stdout.write('locked');
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
                return 'lost';
            }});
        `,
            ],
            { env: { ...process.env, TACO_HOME: home }, stdio: ["ignore", "pipe", "pipe"] },
        );
        const exited = once(child, "exit");
        await once(child.stdout, "data");
        child.kill("SIGKILL");
        await exited;
        const pid = child.pid;
        assert.ok(pid);
        await waitUntilReaped(pid);
        saveGlobalConfig({ defaultProvider: "recovered" });
        assert.equal(readGlobalConfig().defaultModel, "kept");
        assert.equal(readGlobalConfig().defaultProvider, "recovered");
        assert.deepEqual(readdirSync(home), ["taco.json"]);
    });

    it("preserves the write error when temporary and lock cleanup also fail", () => {
        saveGlobalConfig({ defaultModel: "kept" });
        const realWrite = fs.writeFileSync;
        const realUnlink = fs.unlinkSync;
        mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
            if (String(args[0]).includes(".tmp-")) {
                realWrite(args[0], "partial", args[2]);
                throw new Error("original write failure");
            }
            return realWrite(...args);
        });
        mock.method(fs, "unlinkSync", (...args: Parameters<typeof fs.unlinkSync>) => {
            if (String(args[0]).includes(".tmp-") || String(args[0]).includes(".lock/")) {
                throw new Error("cleanup failure");
            }
            return realUnlink(...args);
        });
        syncBuiltinESMExports();
        try {
            assert.throws(
                () => saveGlobalConfig({ defaultModel: "lost" }),
                /original write failure/,
            );
        } finally {
            mock.restoreAll();
            syncBuiltinESMExports();
        }
        assert.equal(readGlobalConfig().defaultModel, "kept");
        saveGlobalConfig({ defaultProvider: "after-recovery" });
        assert.equal(readGlobalConfig().defaultProvider, "after-recovery");
        assert.equal(fs.existsSync(join(home, "taco.json.lock")), false);
    });

    it("creates a missing config home before acquiring the lock", () => {
        process.env.TACO_HOME = join(home, "nested", "config");
        saveGlobalConfig({ defaultModel: "created" });
        assert.equal(readGlobalConfig().defaultModel, "created");
    });

    it("creating a channel preserves newer disk config over the startup snapshot", () => {
        const original = {
            channelId: "existing",
            manifest: { name: "wechat", version: "1.0.0" },
            config: { value: "startup" },
        };
        const control = createChannelControl({ getChannelConfigs: () => [original] } as never);
        saveGlobalConfig({ channels: [{ ...original, config: { value: "newer" } }] });
        control.channels.create("wechat", "new");
        assert.deepEqual(readGlobalConfig().channels?.[0].config, { value: "newer" });
    });

    it("readers only observe complete old or new files during repeated writes", async () => {
        saveGlobalConfig({ defaultModel: "0", systemPrompt: "0".repeat(32768) });
        const writer = worker(
            home,
            `
            import { saveGlobalConfig } from ${JSON.stringify(configUrl)};
            for (let n = 1; n <= 60; n++) {
                const value = String(n % 10);
                saveGlobalConfig({ defaultModel: value, systemPrompt: value.repeat(32768) });
            }
        `,
        );
        let finished = false;
        void writer.done.finally(() => {
            finished = true;
        });
        // The loop reads at least once before the writer can finish.
        while (!finished) {
            const config = JSON.parse(readFileSync(join(home, "taco.json"), "utf8"));
            assert.equal(config.systemPrompt, config.defaultModel.repeat(32768));
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
        await writer.done;
    });

    it("keeps the previous file and releases transaction resources after validation failure", () => {
        saveGlobalConfig({ defaultModel: "kept" });
        const before = readFileSync(join(home, "taco.json"), "utf8");
        assert.throws(() => saveGlobalConfig({ thinkingLevel: "invalid" } as never));
        assert.equal(readFileSync(join(home, "taco.json"), "utf8"), before);
        assert.deepEqual(readdirSync(home), ["taco.json"]);
        saveGlobalConfig({ defaultProvider: "next" });
        assert.equal(readGlobalConfig().defaultModel, "kept");
    });
});

it("preserves nested provider credentials when resolving unrelated config changes", () => {
    const previous = process.env.TACO_HOME;
    const home = mkdtempSync(join(tmpdir(), "taco-nested-keys-"));
    process.env.TACO_HOME = home;
    try {
        saveGlobalConfig({ apiKeys: { openai: "nested-openai", anthropic: "nested-anthropic" } });
        assert.equal(resolveConfig().apiKeys.openai, "nested-openai");
        assert.equal(resolveConfig().apiKeys.anthropic, "nested-anthropic");
        assert.equal(resolveConfig({ openaiApiKey: "cli" }).apiKeys.openai, "cli");
    } finally {
        if (previous === undefined) Reflect.deleteProperty(process.env, "TACO_HOME");
        else process.env.TACO_HOME = previous;
        rmSync(home, { recursive: true, force: true });
    }
});
