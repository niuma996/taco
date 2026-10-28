import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { type RpcResponse, SIDECAR_PROTOCOL_VERSION } from "@taco-ai/protocol";

test("daemon serves filesystem workspaces after router startup rejects", {
    timeout: 20000,
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
        ["--import", "tsx", "--input-type=module", "--eval", bootstrap],
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
                12000,
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
