/**
 * `taco status` — query the running daemon via the control socket.
 *
 * Sends a single `control.ping` JSON-RPC request and prints the daemon's
 * version / protocol / uptime / pid reply as JSON. Useful for liveness checks
 * from shell scripts (`taco status >/dev/null || taco start`) and for human
 * diagnosis of "is the daemon actually up?".
 *
 * Wire format + retry behaviour live in `@taco-ai/shared/controlNode` so
 * `taco stop` and any future control-socket client share a single impl.
 */

import { controlRequest } from "@taco-ai/shared/controlNode";
import { controlSocketPath } from "./paths.ts";

const PING_TIMEOUT_MS = 2_000;

export async function statusCommand(): Promise<void> {
    const control = controlSocketPath();
    const result = await controlRequest(control, "control.ping", { timeoutMs: PING_TIMEOUT_MS });
    process.stdout.write(`${JSON.stringify(result)}\n`);
}
