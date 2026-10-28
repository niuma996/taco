import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { type RpcResponse, SIDECAR_PROTOCOL_VERSION } from "@taco-ai/protocol";

function client(socket: Socket) {
    const pending = new Map<string, (response: RpcResponse) => void>();
    const reader = createInterface({ input: socket });
    reader.on("line", (line) => {
        const response = JSON.parse(line) as RpcResponse;
        if ("ok" in response) {
            pending.get(response.id)?.(response);
            pending.delete(response.id);
        }
    });
    return {
        request(id: string, method: string, params: unknown): Promise<RpcResponse> {
            return new Promise((done) => {
                pending.set(id, done);
                socket.write(`${JSON.stringify({ id, method, params })}\n`);
            });
        },
        close() {
            reader.close();
            socket.destroy();
        },
    };
}

test("daemon retains one workspace across connections and shuts down with a client still open", {
    timeout: 20000,
}, async () => {
    const home = await mkdtemp(join(tmpdir(), "taco-daemon-"));
    const socketPath =
        process.platform === "win32"
            ? `\\\\.\\pipe\\taco-test-${process.pid}-${Date.now()}`
            : join(home, "rpc.sock");
    const controlPath = `${socketPath}-ctl`;
    const child = spawn(process.execPath, ["--import", "tsx", "packages/sidecar/src/index.ts"], {
        cwd: resolve(import.meta.dirname, "../../../.."),
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
    });
    const exited = once(child, "exit");
    let stderr = "";
    let a: ReturnType<typeof client> | undefined;
    let b: ReturnType<typeof client> | undefined;
    let control: Socket | undefined;
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
            exited.then(() => {
                clearTimeout(timer);
                reject(new Error(stderr));
            });
        });
        const socketA = connect(socketPath);
        const socketB = connect(socketPath);
        await Promise.all([once(socketA, "connect"), once(socketB, "connect")]);
        a = client(socketA);
        b = client(socketB);
        const init = { protocolVersion: SIDECAR_PROTOCOL_VERSION, clientCapabilities: {} };
        assert.equal((await a.request("init-a", "initialize", init)).ok, true);
        assert.equal((await b.request("init-b", "initialize", init)).ok, true);
        const cwd = join(home, "workspace");
        const { mkdir } = await import("node:fs/promises");
        await mkdir(cwd);
        assert.equal((await a.request("ensure", "workspace.ensure", { cwd })).ok, true);
        const listed = await b.request("list", "workspace.list", {});
        assert.ok(listed.ok);
        assert.deepEqual(listed.result, [cwd]);
        a.close();
        const retained = await b.request("retained", "workspace.list", {});
        assert.ok(retained.ok);
        assert.deepEqual(retained.result, [cwd]);
        control = connect(controlPath);
        await once(control, "connect");
        control.write(`${JSON.stringify({ id: 1, method: "control.shutdown" })}\n`);
        const [code] = await exited;
        assert.equal(code, 0, stderr);
        await assert.rejects(readFile(join(home, "sidecar.pid")), { code: "ENOENT" });
    } finally {
        a?.close();
        b?.close();
        control?.destroy();
        if (child.exitCode === null) {
            child.kill("SIGKILL");
            await exited;
        }
        await rm(home, { recursive: true, force: true });
    }
});
