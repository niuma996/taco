/**
 * `taco stop` — ask the running daemon to shut down via the control socket.
 *
 * Sends a single `control.shutdown` JSON-RPC request and waits for the
 * `{result: {ok: true}}` reply (the daemon flushes the reply before exiting,
 * so a successful read here means the shutdown ack was accepted). Then we
 * wait up to 3s for the NDJSON socket file to disappear (the daemon
 * unlinks both sockets on its way out — see `unlinkSocketSync` in
 * packages/sidecar/src/index.ts). If it lingers past the deadline, we
 * report that the daemon accepted shutdown but the cleanup is taking longer
 * than expected — operator-visible rather than silently broken.
 */

import { connect, type Socket } from "node:net";
import { controlSocketPath } from "./paths.ts";

const SHUTDOWN_ACK_TIMEOUT_MS = 3_000;
const SOCKET_GONE_TIMEOUT_MS = 3_000;

interface ControlReplyOk {
    result: unknown;
    id: number;
}
interface ControlReplyErr {
    error: { code: string; message: string };
    id: number;
}

function sendControlRequest(socketPath: string, method: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const sock: Socket = connect(socketPath);
        let buf = "";
        let done = false;
        const finish = (fn: () => void) => {
            if (done) return;
            done = true;
            sock.destroy();
            fn();
        };
        const timer = setTimeout(() => {
            finish(() =>
                reject(new Error(`${method} timed out after ${SHUTDOWN_ACK_TIMEOUT_MS}ms`)),
            );
        }, SHUTDOWN_ACK_TIMEOUT_MS);

        sock.once("error", (err) => {
            clearTimeout(timer);
            finish(() => reject(new Error(`${method}: ${err.message}`)));
        });
        sock.once("connect", () => {
            sock.write(`${JSON.stringify({ method, id: 1 })}\n`);
        });
        sock.on("data", (chunk) => {
            buf += chunk.toString("utf8");
            const nl = buf.indexOf("\n");
            if (nl < 0) return;
            const line = buf.slice(0, nl);
            clearTimeout(timer);
            try {
                const reply = JSON.parse(line) as ControlReplyOk | ControlReplyErr;
                if ("error" in reply) {
                    finish(() =>
                        reject(new Error(`${method}: ${reply.error.code} ${reply.error.message}`)),
                    );
                } else {
                    finish(() => resolve(reply.result));
                }
            } catch (err) {
                finish(() => reject(new Error(`${method}: malformed reply: ${String(err)}`)));
            }
        });
        sock.on("close", () => {
            clearTimeout(timer);
            if (!done) {
                finish(() => reject(new Error(`${method}: socket closed before reply`)));
            }
        });
    });
}

async function waitForSocketGone(path: string): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < SOCKET_GONE_TIMEOUT_MS) {
        // On Unix, stat the file; on Windows, named pipes don't leave
        // filesystem entries so we treat the absence as already gone.
        if (process.platform === "win32") return;
        // existsSync throws if path is unreadable; treat that as "gone" too —
        // the listener has shut down so subsequent connect attempts will fail.
        let exists = true;
        try {
            exists = (await import("node:fs")).existsSync(path);
        } catch {
            exists = false;
        }
        if (!exists) return;
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`socket ${path} still present after ${SOCKET_GONE_TIMEOUT_MS}ms`);
}

export async function stopCommand(): Promise<void> {
    const control = controlSocketPath();
    const result = await sendControlRequest(control, "control.shutdown");
    // Daemon flushes the reply, then unlinks + exits. Give it a moment to
    // actually disappear from the filesystem before declaring success.
    await waitForSocketGone(control);
    process.stdout.write(`${JSON.stringify(result ?? { ok: true })}\n`);
}
