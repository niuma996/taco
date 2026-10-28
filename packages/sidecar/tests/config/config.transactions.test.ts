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
import { ConfigStore } from "../../src/config/configStore.ts";
import { createChannelControl } from "../../src/server/channelControl.ts";

const mcpUrl = new URL("../../src/server/handlers/mcp.ts", import.meta.url).href;
const callUrl = new URL("../_helpers/handlerCall.ts", import.meta.url).href;
const channelUrl = new URL("../../src/server/channelControl.ts", import.meta.url).href;
const configUrl = new URL("../../src/config/config.ts", import.meta.url).href;

function worker(home: string, source: string) {
    const child = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", source],
        {
            env: { ...process.env, TACO_HOME: home },
            stdio: ["pipe", "pipe", "pipe"],
        },
    );
    let errors = "";
    child.stderr.setEncoding("utf8").on("data", (data: string) => {
        errors += data;
    });
    const done = once(child, "exit").then(([code]) => {
        assert.equal(code, 0, errors);
    });
    return { child, done };
}

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
        const workers = Array.from({ length: 4 }, (_, id) =>
            worker(
                home,
                `
            import { saveGlobalConfig } from ${JSON.stringify(configUrl)};
            process.stdout.write('ready');
            await new Promise(resolve => process.stdin.once('data', resolve));
            for (let n = 0; n < 8; n++) {
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
        assert.equal(Object.keys(stored.apiKeys).length, 33);
        assert.equal(stored.apiKeys.initial, "kept");
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

    it("bounds contention without stealing a live process lock", () => {
        saveGlobalConfig({ defaultModel: "kept" });
        const lock = join(home, "taco.json.lock");
        mkdirSync(lock);
        writeFileSync(join(lock, `${process.pid}-other-owner`), "");
        const started = performance.now();
        assert.throws(() => saveGlobalConfig({ defaultModel: "lost" }), /timed out.*config lock/i);
        assert.ok(performance.now() - started < 4000);
        assert.equal(
            JSON.parse(readFileSync(join(home, "taco.json"), "utf8")).defaultModel,
            "kept",
        );
        assert.deepEqual(readdirSync(lock), [`${process.pid}-other-owner`]);
    });

    it("recovers a dead process lock and removes only its own owner token", async () => {
        const exited = worker(home, "");
        const pid = exited.child.pid;
        assert.ok(pid);
        await exited.done;
        const lock = join(home, "taco.json.lock");
        mkdirSync(lock);
        writeFileSync(join(lock, `${pid}-dead-owner`), "");
        saveGlobalConfig({ defaultModel: "recovered" });
        assert.deepEqual(readdirSync(home), ["taco.json"]);
        saveGlobalConfig({
            get defaultProvider() {
                rmSync(lock, { recursive: true, force: true });
                mkdirSync(lock);
                writeFileSync(join(lock, `${process.pid}-replacement`), "");
                return "next";
            },
        });
        assert.deepEqual(readdirSync(lock), [`${process.pid}-replacement`]);
    });

    it("bounds reentrant transactions from the same process", () => {
        assert.throws(
            () =>
                saveGlobalConfig({
                    get defaultModel() {
                        saveGlobalConfig({ defaultProvider: "nested" });
                        return "outer";
                    },
                }),
            /timed out.*config lock/i,
        );
        assert.deepEqual(readdirSync(home), []);
    });

    it("coordinates multiple store instances and releases after a rejected mutation", () => {
        const first = new ConfigStore();
        const second = new ConfigStore();
        const path = join(home, "taco.json");
        first.update(path, () => ({ defaultModel: "kept" }));
        assert.throws(
            () => first.update(path, () => second.update(path, () => ({}))),
            /timed out/i,
        );
        second.update(path, (current) => ({ ...current, defaultProvider: "next" }));
        assert.equal(first.read(path).defaultProvider, "next");
        assert.equal(first.read(path).defaultModel, "kept");
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

    it("handles EACCES as contention only when the lock exists", () => {
        const realRename = fs.renameSync;
        mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
            if (String(args[1]).endsWith(".lock")) {
                throw Object.assign(new Error("access denied"), { code: "EACCES" });
            }
            return realRename(...args);
        });
        syncBuiltinESMExports();
        try {
            assert.throws(() => saveGlobalConfig({}), /access denied/);
            const lock = join(home, "taco.json.lock");
            mkdirSync(lock);
            writeFileSync(join(lock, `${process.pid}-live`), "");
            assert.throws(() => saveGlobalConfig({}), /timed out.*config lock/i);
        } finally {
            mock.restoreAll();
            syncBuiltinESMExports();
        }
    });

    it("derives MCP collection additions inside the cross-process transaction", async () => {
        const workers = Array.from({ length: 3 }, (_, id) =>
            worker(
                home,
                `
            import { registerMcpHandlers } from ${JSON.stringify(mcpUrl)};
            import { callMethod } from ${JSON.stringify(callUrl)};
            registerMcpHandlers();
            process.stdout.write('ready');
            await new Promise(resolve => process.stdin.once('data', resolve));
            for (let n = 0; n < 4; n++) {
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
        assert.equal(readGlobalConfig().mcpServers?.length, 12);
    });

    it("derives channel additions from locked disk state despite warm process caches", async () => {
        saveGlobalConfig({ channels: [] });
        const workers = Array.from({ length: 3 }, (_, id) =>
            worker(
                home,
                `
            import { readGlobalConfig } from ${JSON.stringify(configUrl)};
            import { createChannelControl } from ${JSON.stringify(channelUrl)};
            readGlobalConfig();
            const control = createChannelControl({ getChannelConfigs: () => [] });
            process.stdout.write('ready');
            await new Promise(resolve => process.stdin.once('data', resolve));
            for (let n = 0; n < 8; n++) control.channels.create('wechat', 'wechat-${id}-' + n);
            process.stdin.destroy();
        `,
            ),
        );
        await Promise.all(workers.map(({ child }) => once(child.stdout, "data")));
        for (const { child } of workers) child.stdin.end("go");
        await Promise.all(workers.map(({ done }) => done));
        assert.equal(readGlobalConfig().channels?.length, 24);
    });

    it("recovers after a writer process dies while holding the lock", async () => {
        saveGlobalConfig({ defaultModel: "kept" });
        const child = spawn(
            process.execPath,
            [
                "--import",
                "tsx",
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
        let reads = 0;
        let finished = false;
        void writer.done.finally(() => {
            finished = true;
        });
        while (!finished) {
            const config = JSON.parse(readFileSync(join(home, "taco.json"), "utf8"));
            assert.equal(config.systemPrompt, config.defaultModel.repeat(32768));
            reads++;
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
        await writer.done;
        assert.ok(reads > 1);
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
