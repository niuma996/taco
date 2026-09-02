/**
 * controlNode — minimal JSON-RPC client for the sidecar's control socket.
 *
 * The control socket is a separate NDJSON stream from the data channel.
 * Wire format is one JSON object per line (see
 * `packages/sidecar/src/server/controlChannel.ts`):
 *
 *   Request:  {"method": "control.X", "params"?: ..., "id": <number>}
 *   Response: {"result": ..., "id": <number>}
 *              | {"error": {"code", "message"}, "id": <number>}
 *
 * Why a separate socket (and a separate client helper):
 *   - Liveness checks (`control.ping`) and shutdown (`control.shutdown`)
 *     must not be blocked by a stuck / half-closed data socket.
 *   - Both `taco status` and `taco stop` were carrying near-identical
 *     ~50-line implementations of this protocol with slightly different
 *     error formatting — extracting it keeps the wire format in one place.
 *
 * Usage:
 *
 *   import { controlRequest } from "@taco-ai/shared/controlNode";
 *
 *   const result = await controlRequest(socketPath, "control.ping", {
 *     timeoutMs: 2_000,
 *   });
 *
 * The helper rejects (does not throw synchronously) with an `Error`
 * whose `.message` always includes the method name so log lines are
 * unambiguous. Cancellation is best-effort: the timeout closes the
 * underlying socket so a slow / unresponsive daemon does not leak
 * file descriptors.
 */

import { connect, type Socket } from "node:net";

const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_ID = 1;

interface ControlReplyOk {
    result: unknown;
    id: number;
}
interface ControlReplyErr {
    error: { code: string; message: string };
    id: number;
}
type ControlReply = ControlReplyOk | ControlReplyErr;

export interface ControlRequestOptions {
    /** Optional RPC params payload — included as `params` in the wire frame. */
    params?: unknown;
    /** Total wait for one reply. Default 3s; status uses 2s, stop uses 3s. */
    timeoutMs?: number;
    /** Request id — defaults to 1, matching the previous per-caller shape. */
    id?: number;
}

/**
 * Send one `control.<method>` request and resolve with the reply's
 * `result`. Rejects with an `Error` labelled with the method name when:
 *   - the socket cannot connect (ECONNREFUSED / ENOENT / ...)
 *   - the reply is malformed JSON
 *   - the reply carries an `error` field
 *   - the socket closes before any reply
 *   - the timeout elapses with no reply
 */
export function controlRequest(
    socketPath: string,
    method: string,
    options: ControlRequestOptions = {},
): Promise<unknown> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const id = options.id ?? DEFAULT_ID;
    const frame: { method: string; id: number; params?: unknown } = { method, id };
    if (options.params !== undefined) frame.params = options.params;

    return new Promise((resolve, reject) => {
        const sock: Socket = connect(socketPath);
        let buf = "";
        let settled = false;
        const finish = (fn: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            sock.destroy();
            fn();
        };
        const timer = setTimeout(() => {
            finish(() => reject(new Error(`${method} timed out after ${timeoutMs}ms`)));
        }, timeoutMs);

        sock.once("error", (err) => {
            finish(() => reject(new Error(`${method}: ${err.message}`)));
        });
        sock.once("connect", () => {
            sock.write(`${JSON.stringify(frame)}\n`);
        });
        sock.on("data", (chunk) => {
            buf += chunk.toString("utf8");
            const nl = buf.indexOf("\n");
            if (nl < 0) return;
            const line = buf.slice(0, nl);
            try {
                const reply = JSON.parse(line) as ControlReply;
                if ("error" in reply) {
                    finish(() =>
                        reject(new Error(`${method}: ${reply.error.code}: ${reply.error.message}`)),
                    );
                } else {
                    finish(() => resolve(reply.result));
                }
            } catch (err) {
                finish(() => reject(new Error(`${method}: malformed reply: ${String(err)}`)));
            }
        });
        // 'end' fires when the remote half-closes the connection (FIN
        // received). On a graceful server-side end() we observe end
        // before close — close fires only after the local socket drains,
        // which can race with the test runner. Handling both gives a
        // deterministic close-before-reply rejection.
        sock.on("end", () => {
            if (!settled) {
                finish(() => reject(new Error(`${method}: socket closed before reply`)));
            }
        });
        sock.on("close", () => {
            if (!settled) {
                finish(() => reject(new Error(`${method}: socket closed before reply`)));
            }
        });
    });
}
