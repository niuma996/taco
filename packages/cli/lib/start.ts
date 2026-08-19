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

import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { computeInstallId, parsePidFile } from "./installId.ts";
import { findPlatformPkg } from "./installHelpers.ts";
import { controlSocketPath, ndjsonSocketPath, RUN_DIR, TACO_HOME } from "./paths.ts";
import { launchSidecar } from "./sidecarLauncher.ts";
import { acquireStartLock, readStartLock } from "./startLock.ts";
import { upgradeApplyCommand } from "./upgradeApply.ts";
import { markerTargetsInstall, readUpgradeMarker } from "./upgradeMarker.ts";

const READY_TIMEOUT_MS = 15_000;
const PROBE_INTERVAL_MS = 50;
/** How long a lock loser waits for the winner's daemon. Longer than
 *  READY_TIMEOUT_MS because the winner may only just have started spawning. */
const FOLLOWER_WAIT_MS = 20_000;
/** Grace window between SIGTERM and SIGKILL when reaping a wedged daemon. */
const KILL_GRACE_MS = 3_000;

/** Result of probing the NDJSON socket for a live, serving daemon. */
type DaemonProbe = "ready" | "absent" | "wedged";

/** True readiness probe: connect to the NDJSON socket and wait for the
 *  daemon's one-shot `sidecar.hello` frame. A bare TCP connect is NOT a
 *  valid probe — the kernel completes connections from the listen backlog
 *  even when the daemon's event loop is wedged, and the control socket is
 *  bound early in boot (long before the NDJSON listener exists), so both
 *  older probes reported "ready" against daemons that couldn't serve a
 *  single frame. The desktop then timed out waiting for a hello that was
 *  never going to come.
 *
 *  Deliberately self-contained rather than imported from the sidecar: the
 *  CLI does not depend on sidecar TS source (only the bundled platform pkg
 *  ships at runtime). Same reasoning as the note atop `upgradeMarker.ts`. */
function probeDaemonHello(path: string, timeoutMs = 2_000): Promise<DaemonProbe> {
    return new Promise((resolve) => {
        const sock: Socket = connect(path);
        let buf = "";
        const timer = setTimeout(() => finish("wedged"), timeoutMs);
        function finish(result: DaemonProbe): void {
            clearTimeout(timer);
            sock.destroy();
            resolve(result);
        }
        sock.on("data", (chunk) => {
            buf += chunk.toString("utf8");
            const nl = buf.indexOf("\n");
            if (nl === -1) return;
            try {
                const frame = JSON.parse(buf.slice(0, nl)) as { method?: unknown };
                finish(frame.method === "sidecar.hello" ? "ready" : "wedged");
            } catch {
                finish("wedged");
            }
        });
        sock.once("error", () => finish("absent"));
    });
}

function pidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException)?.code === "EPERM";
    }
}

/** Reap a daemon that accepts connections but won't serve them.
 *
 *  Order matters:
 *    1. Read pid file with `parsePidFile` (JSON record preferred, bare-int
 *       legacy accepted for backward compat).
 *    2. Skip reap if the file's `install_id` (when present) does not match
 *       this CLI's own install id — otherwise we'd kill a sibling taco
 *       install that happens to share $TACO_HOME.
 *    3. SIGTERM via the pid, grace window, then SIGKILL — SIGKILL skips
 *       the daemon's exit handlers so we unlink sockets + pid file
 *       ourselves, otherwise the next daemon's single-instance probe
 *       would see a ghost listener and exit.
 *
 *  Without this path a wedged daemon made every subsequent launch fail
 *  until the machine was rebooted. */
async function killWedgedDaemon(
    runDir: string,
    socket: string,
    control: string,
    ownInstallId: string,
): Promise<void> {
    const pidFile = join(runDir, "sidecar.pid");
    let parsed: ReturnType<typeof parsePidFile> | null = null;
    try {
        parsed = parsePidFile(readFileSync(pidFile, "utf8"));
    } catch {
        parsed = null;
    }
    // install_id is null for legacy bare-int files. We reap those — a
    // pre-PR-A daemon is the only thing that could have written them,
    // and the migration to the new format happens naturally on the next
    // fresh spawn.
    const ownerMatches =
        parsed !== null && (parsed.installId === null || parsed.installId === ownInstallId);
    if (parsed !== null && ownerMatches) {
        const pid = parsed.pid;
        try {
            process.kill(pid, "SIGTERM");
        } catch {
            /* already dead */
        }
        const deadline = Date.now() + KILL_GRACE_MS;
        while (Date.now() < deadline && pidAlive(pid)) {
            await new Promise((r) => setTimeout(r, 100));
        }
        if (pidAlive(pid)) {
            try {
                process.kill(pid, "SIGKILL");
            } catch {
                /* already dead */
            }
        }
    }
    for (const p of [socket, control, pidFile]) {
        try {
            unlinkSync(p);
        } catch {
            /* absent — fine */
        }
    }
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

/** If an upgrade marker targets this CLI's own install root, apply it.
 *  Best-effort: a failed apply (e.g. staging dir wiped) must not block the
 *  daemon from starting on the old bundle — the marker-clearing policy
 *  lives in upgradeApplyCommand. */
/** Resolve the resources root the daemon would use when started by this CLI.
 *  Mirrors `sidecarLauncher.ts::launchSidecar`'s dev/prod branch so the
 *  install_id we stamp on the reap check matches the id the daemon will
 *  stamp on its own pid file (sidecar/index.ts computes its id from
 *  TACO_SIDECAR_RESOURCES). Without this symmetry, standalone \`taco start\`
 *  (npm global) — whose own process doesn't see TACO_SIDECAR_RESOURCES —
 *  computed hash("") and skipped every wedged reap as ForeignInstall,
 *  leaving the wedged daemon alive until the next start. */
function resolveDaemonResourcesRoot(): string | undefined {
    const repoRoot = (() => {
        try {
            // Replicate sidecarLauncher.ts:findRepoRoot's pnpm-workspace.yaml walk.
            const url = new URL(import.meta.url);
            let dir = path.dirname(fileURLToPath(url));
            for (let i = 0; i < 8; i++) {
                if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
                const parent = path.dirname(dir);
                if (parent === dir) break;
                dir = parent;
            }
            return null;
        } catch {
            return null;
        }
    })();
    const useDev =
        repoRoot !== null && process.env.TACO_SIDECAR_DEV !== "0";
    if (useDev && repoRoot) {
        return join(repoRoot, "packages", "sidecar", "src");
    }
    // Prod: walk @taco-ai/sidecar-<platform>/ optional deps.
    try {
        const req = createRequire(import.meta.url);
        for (const key of [
            "@taco-ai/sidecar-darwin-arm64",
            "@taco-ai/sidecar-darwin-x64",
            "@taco-ai/sidecar-linux-arm64",
            "@taco-ai/sidecar-linux-x64",
            "@taco-ai/sidecar-win32-arm64",
            "@taco-ai/sidecar-win32-x64",
        ]) {
            try {
                const pkgJsonPath = req.resolve(`${key}/package.json`);
                return path.dirname(pkgJsonPath);
            } catch {
                /* try next platform */
            }
        }
    } catch {
        /* no platform pkg installed */
    }
    return undefined;
}

async function applyOwnedPendingUpgrade(tacoHome: string): Promise<void> {
    const marker = await readUpgradeMarker(join(tacoHome, "upgrade-marker.json"));
    if (!marker) return;
    if (!markerTargetsInstall(marker, findPlatformPkg()?.resources)) return;
    try {
        const { version } = await upgradeApplyCommand({ tacoHome });
        process.stderr.write(`[taco] applied pending upgrade → ${version}\n`);
    } catch (err) {
        process.stderr.write(
            `[taco] pending upgrade could not be applied (${String(err)}); starting existing version\n`,
        );
    }
}

export async function startCommand(opts: StartOptions = {}): Promise<void> {
    const tacoHome = opts.tacoHome ?? TACO_HOME;
    const runDir = RUN_DIR.startsWith(tacoHome) ? RUN_DIR : `${tacoHome}/run`;
    mkdirSync(runDir, { recursive: true });

    const socket = ndjsonSocketPath(tacoHome);
    const control = controlSocketPath(tacoHome);

    // Fast path: a healthy daemon already owns this $TACO_HOME. The desktop
    // reaches `taco start` from more than one place, so this is the common
    // case, not an edge case. The probe reads the NDJSON hello rather than
    // touching the control socket, which is bound long before the daemon
    // can serve (see probeDaemonHello).
    const probe = await probeDaemonHello(socket);
    if (probe === "ready") {
        process.stdout.write(`${socket}\n`);
        process.stderr.write(`[taco] sidecar daemon already running (socket=${socket})\n`);
        return;
    }
    if (probe === "wedged") {
        // The socket answers connects but no hello arrives — the daemon is
        // alive at the kernel level and dead at the application level.
        // Reap it and fall through to a fresh spawn, or every launch from
        // here on would attach to the same unresponsive process.
        process.stderr.write(
            "[taco] sidecar daemon accepts connections but does not serve; killing it\n",
        );
        const daemonResourcesRoot = resolveDaemonResourcesRoot();
        const ownInstallId = computeInstallId(
            daemonResourcesRoot ?? "",
            tacoHome,
        );
        await killWedgedDaemon(runDir, socket, control, ownInstallId);
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
        // Apply a pending upgrade that targets THIS installation before
        // spawning, so the fresh daemon boots the swapped-in bundle. The
        // daemon exits itself when its orchestrator sees the marker; this is
        // the apply step that completes the loop for standalone (npm)
        // installs — the desktop only applies markers for its own bundled
        // sidecar. Markers owned by other installations sharing $TACO_HOME
        // are left untouched.
        await applyOwnedPendingUpgrade(tacoHome);

        const { child, dev } = launchSidecar({
            socketPath: socket,
            controlSocketPath: control,
            tacoHome,
        });

        // If the bundle exits before binding the socket, surface its stderr
        // (already inherited) and a clear error rather than letting the caller
        // hang on the ready timeout.
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

        // Detach from the child: stop forwarding signals / exit codes. The
        // spawn is already detached (own process group / job object), so
        // after unref the daemon fully outlives this launcher on every OS.
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
