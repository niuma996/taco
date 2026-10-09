/**
 * shell exec primitive used by the unified `shell` tool.
 * Unified spawn + timeout + output truncation.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { HIDDEN_WINDOWS_SPAWN } from "../lib/hiddenWindowsSpawn.ts";
import { isInjectedEnvKey } from "../runtime/models/providerKeyStore.ts";
import type { TextContent } from "../runtime/pi/types.ts";

export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_OUTPUT_BYTES = 1024 * 1024; // 1MB

/**
 * SIGKILL a child that ignored SIGTERM, unless it has already exited.
 *
 * `child.killed` is not "has this process exited" — Node sets it as soon as
 * `kill()` successfully *delivers* a signal, regardless of whether the
 * process acts on it. `if (!child.killed)` after already calling
 * `child.kill("SIGTERM")` is therefore always false, and the SIGKILL escalation
 * below it never fires. `exitCode`/`signalCode` are the pair that actually
 * reflects termination: both stay `null` until the process has exited.
 */
function escalateToSigkill(child: ChildProcess): void {
    if (child.exitCode === null && child.signalCode === null) killProcessTree(child, "SIGKILL");
}

/**
 * Signal a spawned command and everything it started.
 *
 * `spawn(..., { shell: true })` puts `/bin/sh` between us and the real command.
 * For a single simple command sh `exec`s itself away, so `child.kill()` would
 * land on the right process — but for anything compound (`a && b`, `a; b`,
 * `a | b`, `a & wait`) sh stays alive as the group leader and the command runs
 * as its child. Signalling only the leader leaves that grandchild running: it
 * keeps its inherited stdout/stderr pipes open, so the `close` event this
 * module awaits never fires and the tool call hangs until the grandchild exits
 * on its own. A timed-out or aborted `pnpm build && pnpm test` is the common
 * case, not an edge one.
 *
 * `detached: true` (set at spawn) makes the child a process-group leader, so
 * the negative pid addresses the whole group rather than one member. Killing
 * the group also reaches grandchildren the child spawned itself.
 *
 * POSIX-only, and deliberately so: on Windows `detached` gives the child its
 * own console window, which is exactly what `HIDDEN_WINDOWS_SPAWN` exists to
 * prevent, and negative pids are not a thing there either. Windows therefore
 * still terminates only the direct child — see `killProcessTree`'s Windows
 * branch for what that leaves behind.
 */
function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
    if (process.platform === "win32" || child.pid === undefined) {
        child.kill(signal);
        return;
    }
    // ESRCH just means the group is already gone — the normal race when a short
    // command finishes between the timeout firing and this call.
    try {
        process.kill(-child.pid, signal);
    } catch {
        child.kill(signal);
    }
}

function truncate(text: string, maxBytes: number): string {
    if (Buffer.byteLength(text, "utf-8") <= maxBytes) return text;
    // Truncate by byte (may split a multibyte char; Buffer→string restores it).
    const buf = Buffer.from(text, "utf-8").subarray(0, maxBytes);
    const kept = buf.toString("utf-8");
    const remaining = Buffer.byteLength(text, "utf-8") - maxBytes;
    return `${kept}\n… [truncated ${remaining} more bytes]`;
}

export interface ShellExecResult {
    content: TextContent[];
    details: { exitCode: number; interrupted: boolean };
    isError: boolean;
}

/**
 * Spawn a child process, capture stdout/stderr, SIGTERM on timeout then
 * SIGKILL 5s later.
 *
 * @param command    Executable / shell command.
 * @param spawnArgs  argv passed to spawn; null uses `{ shell: true }` on Unix
 *                   (/bin/sh); Windows callers pass argv explicitly
 *                   (e.g. `["powershell.exe", "-NoProfile", "-Command"]`).
 */
export async function runShell(
    command: string,
    spawnArgs: string[] | null,
    opts: {
        cwd: string;
        timeoutMs?: number;
        signal?: AbortSignal;
        /**
         * Delay before escalating to SIGKILL after SIGTERM, in ms. Not part
         * of the public tool surface — exists so a test can shrink the
         * escalation window instead of waiting out the real 5s.
         */
        sigkillDelayMs?: number;
    },
): Promise<ShellExecResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const sigkillDelayMs = opts.sigkillDelayMs ?? 5000;
    if (opts.signal?.aborted) throw new Error("Operation aborted");

    // Scrub provider API keys from the child env: shell runs model-generated
    // commands, so it must not inherit keys ProviderKeyStore mirrors into
    // process.env for pi's own subprocesses. Only keys we injected are removed
    // (isInjectedEnvKey); a user's own GOOGLE_API_KEY etc. stays put.
    const childEnv = Object.fromEntries(
        Object.entries(process.env).filter(([k]) => !isInjectedEnvKey(k)),
    );

    // POSIX: the command runs under its own process group so `killProcessTree`
    // can reach every process it starts. Windows: `detached` would pop a console
    // window, so the tree kill there is limited to the direct child.
    const child =
        spawnArgs === null
            ? spawn(command, {
                  cwd: opts.cwd,
                  shell: true,
                  env: childEnv,
                  detached: process.platform !== "win32",
                  ...HIDDEN_WINDOWS_SPAWN,
              })
            : spawn(command, spawnArgs, { cwd: opts.cwd, env: childEnv, ...HIDDEN_WINDOWS_SPAWN });

    let stdout = "";
    let stderr = "";
    let interrupted = false;

    // Decode as UTF-8 across chunk boundaries. `Buffer.toString()` decodes each
    // chunk in isolation, so a multibyte character split across two `data`
    // events yields U+FFFD; StringDecoder buffers the trailing partial bytes.
    // On Windows the caller injects a UTF-8 output preamble into the PowerShell
    // command (see shellTool.ts) so the child's bytes really are UTF-8; on
    // Unix bash/sh already emit UTF-8. Either way this decoder is correct.
    const outDecoder = new StringDecoder("utf8");
    const errDecoder = new StringDecoder("utf8");

    const cap = MAX_OUTPUT_BYTES * 2;
    child.stdout?.on("data", (data: Buffer) => {
        stdout += outDecoder.write(data);
        if (stdout.length > cap) stdout = stdout.slice(-cap);
    });
    child.stderr?.on("data", (data: Buffer) => {
        stderr += errDecoder.write(data);
        if (stderr.length > cap) stderr = stderr.slice(-cap);
    });

    let sigkillTimer: ReturnType<typeof setTimeout> | null = null;
    const timer = setTimeout(() => {
        interrupted = true;
        killProcessTree(child, "SIGTERM");
        // POSIX: SIGTERM gives the child a chance to flush; SIGKILL after 5s is
        // the hard backstop. Windows: kill() maps to TerminateProcess for any
        // signal name, so the SIGTERM→SIGKILL escalation is a no-op there —
        // the first kill is already hard. The code is correct on both; the
        // delay is only meaningful on Unix.
        sigkillTimer = setTimeout(() => escalateToSigkill(child), sigkillDelayMs);
    }, timeoutMs);

    const onAbort = () => {
        interrupted = true;
        killProcessTree(child, "SIGTERM");
        // Same backstop as the timeout path: a child that ignores SIGTERM
        // must not hold the tool — and the parent's abort, which awaits it —
        // open forever. Clear any timer the timeout path already set so the
        // two escalations do not stack.
        if (sigkillTimer) clearTimeout(sigkillTimer);
        sigkillTimer = setTimeout(() => escalateToSigkill(child), sigkillDelayMs);
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const exitCode = await new Promise<number>((resolvePromise) => {
        let settled = false;
        const settle = (code: number) => {
            if (settled) return;
            settled = true;
            resolvePromise(code);
        };
        child.once("close", (code) => settle(code ?? 0));
        child.once("error", () => settle(-1));
    });

    clearTimeout(timer);
    if (sigkillTimer) clearTimeout(sigkillTimer);
    opts.signal?.removeEventListener("abort", onAbort);

    // Flush any bytes the decoder buffered waiting for the rest of a multibyte
    // sequence. On a clean UTF-8 stream this returns "".
    stdout += outDecoder.end();
    stderr += errDecoder.end();

    const outStr = truncate(stdout, MAX_OUTPUT_BYTES);
    const errStr = truncate(stderr, MAX_OUTPUT_BYTES);

    const parts: string[] = [];
    if (outStr) parts.push(outStr);
    if (errStr) parts.push(`[stderr]\n${errStr}`);
    if (interrupted) parts.push(`[interrupted after ${timeoutMs}ms]`);
    if (exitCode !== 0 && !interrupted) parts.push(`[exit code: ${exitCode}]`);

    return {
        content: [{ type: "text", text: parts.join("\n") || "(no output)" }],
        details: { exitCode, interrupted },
        isError: exitCode !== 0 || interrupted,
    };
}
