/**
 * Control channel — a small JSON-RPC over the control socket for out-of-band
 * daemon management. PR2 wires the basic liveness + shutdown RPCs; PR3/PR4
 * add upgrade notifications and UI focus requests.
 *
 * Wire format: one JSON object per line, no length prefix, no start byte.
 * Request:  {"method": "control.X", "params"?: ..., "id": <number>}
 * Response: {"result": ..., "id": <number>} | {"error": {"code", "message"}, "id": <number>}
 *
 * The NDJSON framing matches the data channel so we don't need a new parser;
 * keeping it on a separate socket (instead of multiplexing with NDJSON) means
 * a stuck / half-closed UI socket can't block liveness pings.
 */

import type { Socket } from "node:net";
import * as readline from "node:readline";
import { createLogger } from "../lib/logger.ts";
import { sidecarVersion } from "../runtime/runtimeResources.ts";

const log = createLogger("sidecar.control");

/** Sidecar protocol version + code version; returned by control.ping. */
interface PingResult {
    /** Running sidecar's code version. Launchers compare it against the
     *  version they would spawn and reap on mismatch — the value must be
     *  real in bundles too, so it comes from `runtimeResources.sidecarVersion`
     *  (esbuild define) rather than a node_modules lookup, which resolves
     *  nowhere in a bundled runtime and used to answer "0.0.0". */
    version: string;
    protocol: number;
    uptime_s: number;
    pid: number;
}

export interface ControlRequest {
    method: string;
    params?: unknown;
    id?: number;
}

const SIDECAR_PROTOCOL = 1;
const startEpoch = Date.now();

interface ControlReplyOk {
    result: unknown;
    id: number;
}
interface ControlReplyErr {
    error: { code: string; message: string };
    id: number;
}

function replyOk(socket: Socket, id: number, result: unknown): void {
    const reply: ControlReplyOk = { result, id };
    socket.write(`${JSON.stringify(reply)}\n`);
}

function replyErr(socket: Socket, id: number, code: string, message: string): void {
    const reply: ControlReplyErr = { error: { code, message }, id };
    socket.write(`${JSON.stringify(reply)}\n`);
}

/** Dispatch a single control request. Returns true if the socket should be
 *  closed after replying (e.g. control.shutdown), false otherwise. */
async function dispatch(
    socket: Socket,
    req: ControlRequest,
    onShutdown: () => void | Promise<void>,
): Promise<boolean> {
    const id = typeof req.id === "number" ? req.id : 0;

    switch (req.method) {
        case "control.ping": {
            const result: PingResult = {
                version: sidecarVersion(),
                protocol: SIDECAR_PROTOCOL,
                uptime_s: Math.round((Date.now() - startEpoch) / 1000),
                pid: process.pid,
            };
            replyOk(socket, id, result);
            return false;
        }

        case "control.shutdown": {
            replyOk(socket, id, { ok: true });
            // Defer to let the reply flush before we exit. The caller is
            // responsible for draining the socket (or we just let the OS
            // close it on process exit).
            setImmediate(() => {
                void onShutdown();
            });
            return true;
        }

        default: {
            replyErr(socket, id, "method_not_found", `unknown control method: ${req.method}`);
            return false;
        }
    }
}

/** Bind a control channel handler to the given socket. Returns the readline
 *  interface so the caller can close it on shutdown. */
export function handleControlChannel(
    socket: Socket,
    onShutdown: () => void | Promise<void>,
): readline.Interface {
    const rl = readline.createInterface({ input: socket, crlfDelay: Infinity });
    rl.on("line", (line) => {
        let req: ControlRequest;
        try {
            req = JSON.parse(line) as ControlRequest;
        } catch (err) {
            log.warn(`malformed control request: ${String(err)}`);
            return;
        }
        if (typeof req.method !== "string") {
            log.warn("control request missing method field");
            return;
        }
        dispatch(socket, req, onShutdown).catch((err) => {
            log.error(`control dispatch failed: ${err?.stack ?? err}`);
        });
    });
    rl.on("error", (err) => log.warn(`control readline error: ${err.message}`));
    socket.on("error", (err) => log.warn(`control socket error: ${err.message}`));
    return rl;
}
