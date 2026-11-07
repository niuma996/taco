import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { type RpcResponse, SIDECAR_PROTOCOL_VERSION } from "@taco-ai/protocol";

test("concurrent daemon contenders reuse the socket owner without fatal bind errors", {
    skip: process.platform === "win32",
    // Five contenders each boot a full sidecar (TS transform included), so
    // this needs more headroom than a default timeout allows — the `until`
    // deadline below must be the one that fires, not the runner's.
    timeout: 120_000,
}, async () => {
    const home = await mkdtemp("/tmp/taco-bind-race-");
    const root = resolve(import.meta.dirname, "../../../..");
    const controlPath = join(home, "c.sock");
    const entry = pathToFileURL(join(root, "packages/sidecar/src/index.ts")).href;
    const hooks = pathToFileURL(
        join(root, "packages/sidecar/tests/_helpers/tsResolveHooks.ts"),
    ).href;
    // Hold every contender after its absent-socket probe but before listen().
    // This forces the real macOS EEXIST / Unix EADDRINUSE bind race.
    const bootstrap = `
        import { Server } from "node:net";
        import { existsSync, writeFileSync } from "node:fs";
        const listen = Server.prototype.listen;
        Server.prototype.listen = function (...args) {
            if (args[0] !== process.env.TACO_CONTROL_SOCKET) return listen.apply(this, args);
            writeFileSync(process.env.TACO_HOME + "/ready-" + process.pid, "");
            const timer = setInterval(() => {
                if (!existsSync(process.env.TACO_HOME + "/go")) return;
                clearInterval(timer);
                if (existsSync(args[0])) {
                    const error = Object.assign(new Error("listen EEXIST"), { code: "EEXIST" });
                    this.emit("error", error);
                    return;
                }
                listen.apply(this, args);
            }, 5);
            return this;
        };
        await import(${JSON.stringify(entry)});
    `;
    const children = Array.from({ length: 5 }, () => {
        const child = spawn(
            process.execPath,
            [
                "--experimental-transform-types",
                "--import",
                hooks,
                "--input-type=module",
                "--eval",
                bootstrap,
            ],
            {
                cwd: root,
                env: {
                    ...process.env,
                    TACO_HOME: home,
                    TACO_RUNTIME_DIR: home,
                    TACO_DAEMON_MODE: "1",
                    TACO_SOCKET: join(home, "s.sock"),
                    TACO_CONTROL_SOCKET: controlPath,
                    TACO_STDERR_LOG: "",
                },
                stdio: ["ignore", "ignore", "pipe"],
            },
        );
        let stderr = "";
        child.stderr.on("data", (chunk) => {
            stderr += chunk;
        });
        const exited = once(child, "exit");
        return { child, exited, log: () => stderr };
    });
    const until = async (ready: () => Promise<boolean> | boolean) => {
        // Five contenders each boot a full sidecar; under a parallel test run
        // that startup can take far longer than it does in isolation.
        const deadline = Date.now() + 60_000;
        while (!(await ready())) {
            assert.ok(Date.now() < deadline, children.map((c) => c.log()).join("\n"));
            await new Promise((done) => setTimeout(done, 20));
        }
    };
    try {
        await until(
            async () =>
                (await readdir(home)).filter((name) => name.startsWith("ready-")).length === 5,
        );
        await writeFile(join(home, "go"), "");
        await until(() => children.filter((c) => c.child.exitCode !== null).length >= 4);
        const owner = children.filter((c) => c.child.exitCode === null);
        assert.equal(owner.length, 1);
        for (const contender of children.filter((c) => c.child.exitCode !== null)) {
            assert.equal(contender.child.exitCode, 0, contender.log());
            assert.ok(!contender.log().includes("fatal:"), contender.log());
        }
        await until(() => owner[0].log().includes("daemon listening"));
        const control = connect(controlPath);
        await once(control, "connect");
        control.write(`${JSON.stringify({ id: 1, method: "control.shutdown" })}\n`);
        await owner[0].exited;
        control.destroy();
    } finally {
        await Promise.all(
            children.map(async ({ child, exited }) => {
                if (child.exitCode === null) {
                    child.kill("SIGKILL");
                    await exited;
                }
            }),
        );
        await rm(home, { recursive: true, force: true });
    }
});

test("daemon serves filesystem workspaces after router startup rejects", {
    // Same reasoning as the bind-race test above: the child boots the whole
    // sidecar, so the budget has to cover a loaded machine.
    timeout: 120_000,
}, async () => {
    const home = await mkdtemp(join(tmpdir(), "taco-startup-"));
    const socketPath =
        process.platform === "win32"
            ? `\\\\.\\pipe\\taco-startup-${process.pid}-${Date.now()}`
            : join(home, "rpc.sock");
    const controlPath = `${socketPath}-ctl`;
    const root = resolve(import.meta.dirname, "../../../..");
    const routerUrl = pathToFileURL(
        join(root, "packages/sidecar/src/channels/conversationRouter.ts"),
    ).href;
    const entryUrl = pathToFileURL(join(root, "packages/sidecar/src/index.ts")).href;
    const resolveHooksUrl = pathToFileURL(
        join(root, "packages/sidecar/tests/_helpers/tsResolveHooks.ts"),
    ).href;
    // Inject the failure inside start(), after the resident transport is installed.
    const bootstrap = `
        const { ConversationRouter } = await import(${JSON.stringify(routerUrl)});
        ConversationRouter.prototype.on = () => {
            throw new Error("injected router startup failure");
        };
        await import(${JSON.stringify(entryUrl)});
    `;
    const child = spawn(
        process.execPath,
        [
            "--experimental-transform-types",
            "--import",
            resolveHooksUrl,
            "--input-type=module",
            "--eval",
            bootstrap,
        ],
        {
            cwd: root,
            env: {
                ...process.env,
                TACO_HOME: home,
                TACO_DAEMON_MODE: "1",
                TACO_SOCKET: socketPath,
                TACO_CONTROL_SOCKET: controlPath,
                TACO_RUNTIME_DIR: home,
                TACO_DISABLE_MCP: "1",
                TACO_LOG_LEVEL: "info",
                TACO_STDERR_LOG: "",
            },
            stdio: ["ignore", "ignore", "pipe"],
        },
    );
    const exited = once(child, "exit");
    let stderr = "";
    let socket: Socket | undefined;
    let control: Socket | undefined;
    let reader: ReturnType<typeof createInterface> | undefined;
    try {
        await new Promise<void>((done, reject) => {
            const timer = setTimeout(
                () => reject(new Error(`daemon did not start: ${stderr}`)),
                45000,
            );
            child.stderr.on("data", (chunk) => {
                stderr += String(chunk);
                if (stderr.includes("daemon listening ndjson=")) {
                    clearTimeout(timer);
                    done();
                }
            });
            void exited.then(() => {
                clearTimeout(timer);
                reject(new Error(`daemon exited before binding: ${stderr}`));
            });
        });
        assert.match(stderr, /runtime failed to start: Error: injected router startup failure/);
        socket = connect(socketPath);
        await once(socket, "connect");
        const pending = new Map<string, (response: RpcResponse) => void>();
        reader = createInterface({ input: socket });
        reader.on("line", (line) => {
            const response = JSON.parse(line) as RpcResponse;
            if ("ok" in response) {
                pending.get(response.id)?.(response);
                pending.delete(response.id);
            }
        });
        const connected = socket;
        const request = (id: string, method: string, params: unknown) =>
            new Promise<RpcResponse>((done) => {
                pending.set(id, done);
                connected.write(`${JSON.stringify({ id, method, params })}\n`);
            });
        assert.equal(
            (
                await request("init", "initialize", {
                    protocolVersion: SIDECAR_PROTOCOL_VERSION,
                    clientCapabilities: {},
                })
            ).ok,
            true,
        );
        const cwd = join(home, "workspace");
        await mkdir(cwd);
        assert.equal((await request("ensure", "workspace.ensure", { cwd })).ok, true);
        const listed = await request("list", "workspace.list", {});
        assert.ok(listed.ok);
        assert.deepEqual(listed.result, [cwd]);
        control = connect(controlPath);
        await once(control, "connect");
        control.write(`${JSON.stringify({ id: 1, method: "control.shutdown" })}\n`);
        const [code] = await exited;
        assert.equal(code, 0, stderr);
        await assert.rejects(readFile(join(home, "sidecar.pid")), { code: "ENOENT" });
    } finally {
        reader?.close();
        socket?.destroy();
        control?.destroy();
        if (child.exitCode === null) {
            child.kill("SIGKILL");
            await exited;
        }
        await rm(home, { recursive: true, force: true });
    }
});
