/**
 * shell exec primitive used by the unified `shell` tool.
 * Unified spawn + timeout + output truncation.
 */

import { spawn } from "node:child_process";
import type { TextContent } from "@earendil-works/pi-ai";

export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_OUTPUT_BYTES = 1024 * 1024; // 1MB

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
    opts: { cwd: string; timeoutMs?: number; signal?: AbortSignal },
): Promise<ShellExecResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (opts.signal?.aborted) throw new Error("Operation aborted");

    const child =
        spawnArgs === null
            ? spawn(command, { cwd: opts.cwd, shell: true, env: process.env })
            : spawn(command, spawnArgs, { cwd: opts.cwd, env: process.env });

    let stdout = "";
    let stderr = "";
    let interrupted = false;

    const cap = MAX_OUTPUT_BYTES * 2;
    child.stdout?.on("data", (data: Buffer) => {
        stdout += data.toString();
        if (stdout.length > cap) stdout = stdout.slice(-cap);
    });
    child.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
        if (stderr.length > cap) stderr = stderr.slice(-cap);
    });

    let sigkillTimer: ReturnType<typeof setTimeout> | null = null;
    const timer = setTimeout(() => {
        interrupted = true;
        child.kill("SIGTERM");
        // POSIX: SIGTERM gives the child a chance to flush; SIGKILL after 5s is
        // the hard backstop. Windows: kill() maps to TerminateProcess for any
        // signal name, so the SIGTERM→SIGKILL escalation is a no-op there —
        // the first kill is already hard. The code is correct on both; the
        // delay is only meaningful on Unix.
        sigkillTimer = setTimeout(() => {
            if (!child.killed) child.kill("SIGKILL");
        }, 5000);
    }, timeoutMs);

    const onAbort = () => {
        interrupted = true;
        child.kill("SIGTERM");
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
