/**
 * `taco start` — ensure a daemon is running and report its socket path.
 *
 * Idempotent by design: the desktop can reach this through two independent
 * paths (the setup hook's `taco install`, and `workspace_ensure`'s launcher
 * spawn), and macOS launchd `RunAtLoad=true` adds a third. Spawning
 * unconditionally meant two daemons racing to bind the same control socket,
 * where the loser exited non-zero and launchd restarted it forever.
 *
 * Flow:
 *   1. Resolve $TACO_HOME; create the run/ directory if missing.
 *   2. If a daemon already answers on the control socket, print the NDJSON
 *      path and return — no spawn.
 *   3. Otherwise elect a spawner via `start.lock`. The winner spawns and waits
 *      for readiness; losers skip the spawn and wait on the same socket.
 *   4. Print the NDJSON socket path to stdout (single line) so callers
 *      (Tauri UI / scripts) can read it via `Command::output()`.
 *
 * Why exit after ready: this CLI is a launcher, not a supervisor. Keeping it
 * alive would tie the daemon's lifetime to whoever ran `taco start`.
 */

import { mkdirSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { controlSocketPath, ndjsonSocketPath, RUN_DIR, TACO_HOME } from "./paths.ts";
import { launchSidecar } from "./sidecarLauncher.ts";
import { acquireStartLock, readStartLock } from "./startLock.ts";

const READY_TIMEOUT_MS = 5_000;
const PROBE_INTERVAL_MS = 50;
/** How long a lock loser waits for the winner's daemon. Longer than
 *  READY_TIMEOUT_MS because the winner may only just have started spawning. */
const FOLLOWER_WAIT_MS = 10_000;

/** True when something accepts a connection on `path`.
 *
 *  Deliberately duplicated rather than imported from the sidecar: the CLI does
 *  not depend on sidecar TS source (only the bundled platform pkg ships at
 *  runtime). Same reasoning as the note atop `upgradeMarker.ts`. */
function isListening(path: string): Promise<boolean> {
    return new Promise((resolve) => {
        const sock: Socket = connect(path);
        const finish = (result: boolean) => {
            sock.destroy();
            resolve(result);
        };
        sock.once("connect", () => finish(true));
        sock.once("error", () => finish(false));
    });
}

async function waitForSocket(path: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
        try {
            await new Promise<void>((resolve, reject) => {
                const sock: Socket = connect(path);
                sock.once("connect", () => {
                    sock.destroy();
                    resolve();
                });
                sock.once("error", reject);
            });
            return;
        } catch (e) {
            lastError = e;
            await new Promise((r) => setTimeout(r, PROBE_INTERVAL_MS));
        }
    }
    throw new Error(`socket ${path} did not become ready in ${timeoutMs}ms (${String(lastError)})`);
}

export interface StartOptions {
    /** Override $TACO_HOME (defaults to env / ~/.taco). */
    tacoHome?: string;
}

export async function startCommand(opts: StartOptions = {}): Promise<void> {
    const tacoHome = opts.tacoHome ?? TACO_HOME;
    const runDir = RUN_DIR.startsWith(tacoHome) ? RUN_DIR : `${tacoHome}/run`;
    mkdirSync(runDir, { recursive: true });

    const socket = ndjsonSocketPath(tacoHome);
    const control = controlSocketPath(tacoHome);

    // Fast path: a healthy daemon already owns this $TACO_HOME. The desktop
    // reaches `taco start` from more than one place, so this is the common
    // case, not an edge case.
    if (await isListening(control)) {
        process.stdout.write(`${socket}\n`);
        process.stderr.write(`[taco] sidecar daemon already running (socket=${socket})\n`);
        return;
    }

    const lock = await acquireStartLock(runDir);
    if (!lock) {
        // Another process is mid-spawn. Wait for its daemon rather than racing
        // it to bind the same socket.
        const holder = await readStartLock(`${runDir}/start.lock`);
        try {
            await waitForSocket(socket, FOLLOWER_WAIT_MS);
        } catch (err) {
            throw new Error(
                `another process (pid=${holder?.pid ?? "unknown"}) holds the start lock but its daemon did not become ready: ${String(err)}`,
            );
        }
        process.stdout.write(`${socket}\n`);
        process.stderr.write(`[taco] sidecar daemon started by pid=${holder?.pid ?? "unknown"}\n`);
        return;
    }

    try {
        const { child, dev } = launchSidecar({
            socketPath: socket,
            controlSocketPath: control,
            tacoHome,
        });

        // If the bundle exits before binding the socket, surface its stderr
        // (already inherited) and a clear error rather than letting the caller
        // hang on the 5s ready timeout.
        const exitedEarly = new Promise<never>((_, reject) => {
            child.once("exit", (code, sig) => {
                reject(new Error(`sidecar exited before binding socket (code=${code} sig=${sig})`));
            });
        });

        try {
            await Promise.race([waitForSocket(socket, READY_TIMEOUT_MS), exitedEarly]);
        } catch (err) {
            // Detach: if the child is still alive we let it run (it might
            // recover), but the caller has already failed so we surface it.
            if (!child.killed) child.kill();
            throw err;
        }

        // Detach from the child: stop forwarding signals / exit codes. POSIX
        // reparents the bundle to init once we exit; Windows keeps it alive
        // until our process tree dies.
        child.unref();

        // Last line of stdout = NDJSON socket path. The Rust side parses this
        // with .lines().last() — do not add trailing stdout output.
        process.stdout.write(`${socket}\n`);
        process.stderr.write(
            `[taco] sidecar daemon started (dev=${dev}, socket=${socket}, control=${control}, tacoHome=${tacoHome})\n`,
        );
    } finally {
        // Release on every exit path, including the early throw above —
        // otherwise a failed start wedges every later attempt until the TTL.
        await lock.release();
    }
}
