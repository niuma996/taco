#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { currentTriple } from "../../packages/sidecar/scripts/triple.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const started = Date.now();
let phase = "arguments";

async function check(name, run) {
    phase = name;
    const time = Date.now();
    const result = await run();
    console.log(`[PASS] ${name} (${Date.now() - time}ms)`);
    return result;
}

function buildRuntime() {
    for (const args of [
        ["protocol:build"],
        ["shared:build"],
        ["--filter", "@taco-ai/sidecar", "package:runtime", "--strict"],
    ]) {
        const result = spawnSync("pnpm", args, {
            cwd: repo,
            encoding: "utf8",
            shell: process.platform === "win32",
            timeout: 120_000,
        });
        if (result.error || result.status !== 0) {
            throw new Error(
                `${result.error ?? "build failed"}\n${result.stdout}\n${result.stderr}`,
            );
        }
    }
}

function verifyFiles(runtime) {
    const manifest = JSON.parse(readFileSync(join(runtime, "manifest.json"), "utf8"));
    assert.equal(manifest.target, currentTriple(), "runtime target must match the host");
    assert.equal(manifest.daemonMode, true, "runtime must support daemon mode");
    const nodeName = process.platform === "win32" ? "taco-sidecar-node.exe" : "taco-sidecar-node";
    for (const [file, expected] of [
        ["lib/index.mjs", manifest.bundleSha256],
        [`bin/${nodeName}`, manifest.runtimeSha256],
    ]) {
        assert.equal(typeof expected, "string", `missing checksum: ${file}`);
        const actual = createHash("sha256")
            .update(readFileSync(join(runtime, file)))
            .digest("hex");
        assert.equal(actual, expected, `checksum mismatch: ${file}`);
    }
    for (const resource of [
        "agents/builtin",
        "skills/builtin",
        "extensions/builtin",
        "lib/pdfjs/cmaps",
        "lib/pdfjs/standard_fonts",
    ]) {
        assert.ok(statSync(join(runtime, resource)).isDirectory(), `missing resource: ${resource}`);
    }
    for (const grammar of ["tree-sitter", "tree-sitter-bash", "tree-sitter-powershell"]) {
        assert.ok(statSync(join(runtime, "lib/grammars", `${grammar}.wasm`)).size > 0);
    }
    return { manifest, nodeName };
}

// Each request owns its socket and deadline, including connection failures.
function rpc(path, request) {
    return new Promise((done, reject) => {
        const socket = connect(path);
        const reader = createInterface({ input: socket });
        const timer = setTimeout(() => finish(new Error(`${request.method} timed out`)), 3_000);
        function finish(error, response) {
            clearTimeout(timer);
            reader.close();
            socket.destroy();
            if (error) reject(error);
            else done(response);
        }
        socket.once("error", (error) => finish(error));
        reader.once("error", (error) => finish(error));
        socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
        reader.on("line", (line) => {
            try {
                const response = JSON.parse(line);
                if (response.id === request.id) finish(null, response);
            } catch (error) {
                finish(error);
            }
        });
    });
}

async function smoke(runtime, manifest, nodeName) {
    const temp = mkdtempSync(
        join(process.platform === "win32" ? tmpdir() : "/tmp", "taco-regression-"),
    );
    let child;
    let stderr = "";
    let exited;
    let outcome;
    try {
        // Resolve no workspace dependencies, even when the caller runs from the repo.
        const isolated = join(temp, "runtime");
        cpSync(runtime, isolated, { recursive: true, dereference: true });
        for (let parent = temp; ; parent = dirname(parent)) {
            assert.ok(!existsSync(join(parent, "node_modules")), `not isolated: ${parent}`);
            if (dirname(parent) === parent) break;
        }
        const pipe = `\\\\.\\pipe\\taco-regression-${randomUUID()}`;
        const dataPath = process.platform === "win32" ? pipe : join(temp, "s.sock");
        const controlPath = process.platform === "win32" ? `${pipe}-ctl` : join(temp, "c.sock");
        const env = Object.fromEntries(
            Object.entries(process.env).filter(([key]) =>
                /^(PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|TMPDIR|LANG|LC_ALL)$/i.test(key),
            ),
        );
        Object.assign(env, {
            HOME: temp,
            USERPROFILE: temp,
            SHELL: "/bin/sh",
            TACO_HOME: join(temp, "home"),
            TACO_RUNTIME_DIR: temp,
            TACO_DAEMON_MODE: "1",
            TACO_SOCKET: dataPath,
            TACO_CONTROL_SOCKET: controlPath,
            TACO_SIDECAR_RESOURCES: isolated,
            TACO_DISABLE_MCP: "1",
        });
        const startupDeadline = Date.now() + 15_000;
        child = spawn(join(isolated, "bin", nodeName), [join(isolated, "lib/index.mjs")], {
            cwd: temp,
            env,
            stdio: ["ignore", "ignore", "pipe"],
            windowsHide: true,
        });
        child.stderr.on("data", (chunk) => {
            stderr = (stderr + chunk).slice(-12_000);
        });
        exited = new Promise((done) => {
            child.once("error", (error) => {
                outcome = { error: error.message };
                done(outcome);
            });
            child.once("exit", (code, signal) => {
                outcome = { code, signal };
                done(outcome);
            });
        });
        await check("isolated startup", async () => {
            while (true) {
                assert.ok(!outcome, `exited before ready: ${JSON.stringify(outcome)}`);
                try {
                    const reply = await rpc(controlPath, { id: 1, method: "control.ping" });
                    assert.equal(reply.result?.version, manifest.sidecarVersion);
                    assert.equal(reply.result?.pid, child.pid);
                    return;
                } catch (error) {
                    if (!["ENOENT", "ECONNREFUSED"].includes(error.code)) throw error;
                    if (Date.now() >= startupDeadline) throw new Error("startup exceeded 15s");
                    await new Promise((done) => setTimeout(done, 100));
                }
            }
        });
        await check("protocol handshake", async () => {
            const { SIDECAR_PROTOCOL_VERSION } = await import(
                pathToFileURL(join(repo, "packages/protocol/dist/index.js")).href
            );
            let reply;
            // Control binds first; the data listener may still be initializing.
            while (!reply) {
                assert.ok(!outcome, `exited before handshake: ${JSON.stringify(outcome)}`);
                try {
                    reply = await rpc(dataPath, {
                        id: "regression",
                        method: "initialize",
                        params: {
                            protocolVersion: SIDECAR_PROTOCOL_VERSION,
                            clientCapabilities: {},
                        },
                    });
                } catch (error) {
                    if (!["ENOENT", "ECONNREFUSED"].includes(error.code)) throw error;
                    if (Date.now() >= startupDeadline) throw new Error("data socket exceeded 15s");
                    await new Promise((done) => setTimeout(done, 100));
                }
            }
            assert.equal(reply.ok, true, JSON.stringify(reply));
            assert.equal(reply.result?.serverVersion, manifest.sidecarVersion);
            assert.deepEqual(reply.result?.protocolVersion, SIDECAR_PROTOCOL_VERSION);
        });
        await check("clean shutdown", async () => {
            const reply = await rpc(controlPath, { id: 2, method: "control.shutdown" });
            assert.equal(reply.result?.ok, true);
            let timer;
            try {
                const result = await Promise.race([
                    exited,
                    new Promise((_, reject) => {
                        timer = setTimeout(() => reject(new Error("shutdown exceeded 5s")), 5_000);
                    }),
                ]);
                assert.equal(result.code, 0, JSON.stringify(result));
            } finally {
                clearTimeout(timer);
            }
        });
    } catch (error) {
        throw new Error(`${error.message}\n${stderr}`, { cause: error });
    } finally {
        if (child && !outcome) {
            child.kill("SIGKILL");
            await exited;
        }
        rmSync(temp, { recursive: true, force: true });
    }
}

async function main() {
    const args = process.argv.slice(2);
    let runtime;
    if (args.length > 0) {
        if (args[0] !== "--runtime") throw new Error(`unknown argument: ${args[0]}`);
        if (args.length !== 2 || args[1].startsWith("--")) {
            throw new Error("usage: pnpm regression [--runtime <directory>]");
        }
        runtime = resolve(args[1]);
    } else {
        await check("build runtime", buildRuntime);
        runtime = join(repo, "packages/sidecar/dist/runtime", currentTriple());
    }
    const { manifest, nodeName } = await check("runtime files", () => verifyFiles(runtime));
    await smoke(runtime, manifest, nodeName);
    console.log(`[OK] minimal regression (${((Date.now() - started) / 1000).toFixed(1)}s)`);
}

main().catch((error) => {
    console.error(`[FAIL] ${phase}: ${error.message}`);
    process.exitCode = 1;
});
