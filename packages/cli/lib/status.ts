/**
 * `taco status` — query the running daemon via the control socket.
 *
 * Sends a single `control.ping` JSON-RPC request and prints the daemon's
 * version / protocol / uptime / pid reply as JSON. Useful for liveness checks
 * from shell scripts (`taco status >/dev/null || taco start`) and for human
 * diagnosis of "is the daemon actually up?".
 */

import { connect, type Socket } from "node:net";
import { controlSocketPath } from "./paths.ts";

const PING_TIMEOUT_MS = 2_000;

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
            finish(() => reject(new Error(`${method} timed out after ${PING_TIMEOUT_MS}ms`)));
        }, PING_TIMEOUT_MS);

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
                    finish(() => reject(new Error(`${reply.error.code}: ${reply.error.message}`)));
                } else {
                    finish(() => resolve(reply.result));
                }
            } catch (err) {
                finish(() => reject(new Error(`malformed reply: ${String(err)}`)));
            }
        });
        sock.on("close", () => {
            clearTimeout(timer);
            if (!done) finish(() => reject(new Error("socket closed before reply")));
        });
    });
}

export async function statusCommand(): Promise<void> {
    const control = controlSocketPath();
    const result = await sendControlRequest(control, "control.ping");
    process.stdout.write(`${JSON.stringify(result)}\n`);
}
