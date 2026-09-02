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
 *
 * Wire format + retry behaviour live in `@taco-ai/shared/controlNode` so
 * `taco status` and any future control-socket client share a single impl.
 */

import { existsSync } from "node:fs";
import { controlRequest } from "@taco-ai/shared/controlNode";
import { controlSocketPath } from "./paths.ts";

const SHUTDOWN_ACK_TIMEOUT_MS = 3_000;
const SOCKET_GONE_TIMEOUT_MS = 3_000;

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
            exists = existsSync(path);
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
    const result = await controlRequest(control, "control.shutdown", {
        timeoutMs: SHUTDOWN_ACK_TIMEOUT_MS,
    });
    // Daemon flushes the reply, then unlinks + exits. Give it a moment to
    // actually disappear from the filesystem before declaring success.
    await waitForSocketGone(control);
    process.stdout.write(`${JSON.stringify(result ?? { ok: true })}\n`);
}
