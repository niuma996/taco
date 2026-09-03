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
 *   1. Resolve shared $TACO_HOME and the daemon runtime directory; create both if missing.
 *   2. If a daemon already answers on the NDJSON socket AND runs the code
 *      this launch would spawn (pid-record version match; dev checkouts
 *      never match), print the socket path and return — no spawn. A healthy
 *      but stale daemon is reaped first, via the same kill path as a wedged
 *      one.
 *   3. Otherwise elect a spawner via `start.lock`. The winner spawns and waits
 *      for readiness; losers skip the spawn and wait on the same socket.
 *   4. Print the NDJSON socket path to stdout (single line) so callers
 *      (Tauri UI / scripts) can read it via `Command::output()`.
 *
 * Why exit after ready: this CLI is a launcher, not a supervisor. Keeping it
 * alive would tie the daemon's lifetime to whoever ran `taco start`.
 */

import { readFileSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { connect, type Socket } from "node:net";
import * as path from "node:path";
import { join } from "node:path";
import { findPlatformPkg } from "./installHelpers.ts";
import { computeInstallId, parsePidFile, pidRecordIsStale } from "./installId.ts";
import {
    controlSocketPath,
    ensureDirs,
    ndjsonSocketPath,
    resolveTacoRuntimeDir,
    TACO_HOME,
} from "./paths.ts";
import {
    findRepoRoot,
    isDevCheckout,
    launchSidecar,
    prodSidecarVersion,
} from "./sidecarLauncher.ts";
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

/** Protocol version this CLI advertises in its probe initialize request.
 *  Duplicates @taco-ai/protocol's SIDECAR_PROTOCOL_VERSION because the probe
 *  must stay self-contained (see probeDaemonInitialize). An incompatible
 *  version still gets an error response, which proves liveness — bump in
 *  lockstep when the major changes. */
const PROBE_PROTOCOL_VERSION = { major: 2, minor: 0 };

/** True readiness probe: connect to the NDJSON socket, send a literal
 *  `initialize` request, and wait for its RPC response. A bare TCP connect
 *  is NOT a valid probe — the kernel completes connections from the listen
 *  backlog even when the daemon's event loop is wedged, and the control
 *  socket is bound early in boot (long before the NDJSON listener exists),
 *  so both older probes reported "ready" against daemons that couldn't
 *  serve a single frame.
 *
 *  Deliberately self-contained rather than imported from the sidecar: the
 *  CLI does not depend on sidecar TS source (only the bundled platform pkg
 *  ships at runtime). Same reasoning as the note atop `upgradeMarker.ts`.
 *  The frame duplicates the wire format in @taco-ai/protocol; keep the
 *  shape in sync when RpcRequest / InitializeRpcParams change. */
function probeDaemonInitialize(path: string, timeoutMs = 5_000): Promise<DaemonProbe> {
    return new Promise((resolve) => {
        const sock: Socket = connect(path);
        let buf = "";
        let settled = false;
        const timer = setTimeout(() => finish("wedged"), timeoutMs);
        function finish(result: DaemonProbe): void {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            sock.destroy();
            resolve(result);
        }
        sock.on("connect", () => {
            const req = {
                id: "probe",
                commandId: "probe",
                method: "initialize",
                params: {
                    protocolVersion: PROBE_PROTOCOL_VERSION,
                    clientCapabilities: {},
                },
            };
            sock.write(`${JSON.stringify(req)}\n`);
        });
        sock.on("data", (chunk) => {
            buf += chunk.toString("utf8");
            // Drain every newline-terminated frame: a healthy daemon may push
            // `session.*` / IM / channel frames ahead of the probe's RPC
            // response (push fan-out to late-attaching connections), and the
            // probe must not mistake those for an unresponsive event loop.
            // Only the response carrying id === "probe" + ok:boolean settles.
            let nl = buf.indexOf("\n");
            while (nl !== -1) {
                const line = buf.slice(0, nl);
                buf = buf.slice(nl + 1);
                let frame: { id?: unknown; ok?: unknown };
                try {
                    frame = JSON.parse(line) as { id?: unknown; ok?: unknown };
                } catch {
                    continue;
                }
                if (typeof frame.id !== "string" || typeof frame.ok !== "boolean") continue;
                // Any RPC response (success or error) means the event loop
                // reached our request and answered — the daemon is alive and
                // serving frames, regardless of protocol-version outcome.
                finish("ready");
                return;
            }
            nl = buf.indexOf("\n");
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
    runtimeDir: string,
    socket: string,
    control: string,
    ownInstallId: string,
): Promise<void> {
    const pidFile = join(runtimeDir, "sidecar.pid");
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
    /** Override the daemon runtime directory (defaults to $TACO_RUNTIME_DIR or $TACO_HOME/run). */
    runtimeDir?: string;
}

/** If an upgrade marker targets this CLI's own install root, apply it.
 *  Best-effort: a failed apply (e.g. staging dir wiped) must not block the
 *  daemon from starting on the old bundle — the marker-clearing policy
 *  lives in upgradeApplyCommand. */
/** Resolve the resources root the daemon would use when started by this CLI.
 *  Uses `sidecarLauncher.ts::findRepoRoot`/`isDevCheckout` so the dev/prod
 *  discrimination matches `launchSidecar` exactly — the install_id we stamp
 *  on the reap check must match the id the daemon stamps on its own pid file
 *  (sidecar/index.ts computes its id from TACO_SIDECAR_RESOURCES). Without
 *  this symmetry, standalone \`taco start\` (npm global) — whose own process
 *  doesn't see TACO_SIDECAR_RESOURCES — computed hash("") and skipped every
 *  wedged reap as ForeignInstall, leaving the wedged daemon alive until the
 *  next start. */
function resolveDaemonResourcesRoot(): string | undefined {
    const repoRoot = findRepoRoot();
    if (isDevCheckout(repoRoot) && repoRoot) {
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

/** Why a serving daemon fails the freshness gate, or null when it may be
 *  reused. Dev checkouts always fail: the version string cannot see source
 *  edits, so "same version" says nothing about the code on disk (plan A).
 *  Prod compares the pid record's sidecar_version against the platform
 *  bundle's manifest version; a record we don't own (or can't parse) never
 *  justifies a kill — see pidRecordIsStale. */
function staleDaemonReason(
    runtimeDir: string,
    ownInstallId: string,
    expectedVersion: string,
): string | null {
    let parsed: ReturnType<typeof parsePidFile> | null = null;
    try {
        parsed = parsePidFile(readFileSync(join(runtimeDir, "sidecar.pid"), "utf8"));
    } catch {
        parsed = null;
    }
    if (!pidRecordIsStale(parsed, ownInstallId, expectedVersion)) return null;
    return `pid ${parsed?.pid ?? "?"} runs sidecar ${parsed?.sidecarVersion ?? "unknown"}, expected ${expectedVersion}`;
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
    const runtimeDir = resolveTacoRuntimeDir(tacoHome, opts.runtimeDir);
    await ensureDirs(tacoHome, runtimeDir);

    const socket = ndjsonSocketPath(runtimeDir);
    const control = controlSocketPath(runtimeDir);

    // Fast path: a healthy daemon already owns this runtime directory. The desktop
    // reaches `taco start` from more than one place, so this is the common
    // case, not an edge case. The probe exchanges an initialize request over
    // the NDJSON socket rather than touching the control socket, which is
    // bound long before the daemon can serve (see probeDaemonInitialize).
    let probe = await probeDaemonInitialize(socket);
    if (probe === "wedged") {
        // A daemon mid-initialization or serving a burst of connections can
        // miss one probe. Killing on a single miss turned slow boots into a
        // kill/restart loop, so re-probe once before declaring it wedged.
        await new Promise((r) => setTimeout(r, 500));
        probe = await probeDaemonInitialize(socket);
    }

    const daemonResourcesRoot = resolveDaemonResourcesRoot();
    const ownInstallId = computeInstallId(daemonResourcesRoot ?? "", tacoHome);

    if (probe === "ready") {
        // Healthy is not enough — the daemon must also run the code THIS
        // launch would spawn, or every upgrade/source edit would keep
        // attaching to the previous build forever. Dev checkouts reap
        // unconditionally (the version string can't see source edits); prod
        // compares the pid record's sidecar_version against the platform
        // bundle's manifest. Both reuse killWedgedDaemon — its install_id
        // ownership check still applies, so a foreign install's daemon is
        // never touched (pidRecordIsStale likewise refuses foreign records).
        const devMode = isDevCheckout();
        const expectedVersion = devMode ? null : prodSidecarVersion();
        let staleReason: string | null;
        if (devMode) {
            staleReason = "dev checkout always respawns";
        } else if (expectedVersion !== null) {
            staleReason = staleDaemonReason(runtimeDir, ownInstallId, expectedVersion);
        } else {
            // No manifest version to compare against — reuse rather than reap
            // on every launch, but say so: a silently disabled gate looks
            // exactly like a working one until someone debugs why an upgrade
            // never took effect.
            staleReason = null;
            process.stderr.write(
                "[taco] freshness gate disabled: no bundle manifest version; reused daemon may be stale\n",
            );
        }
        if (staleReason === null) {
            process.stdout.write(`${socket}\n`);
            process.stderr.write(`[taco] sidecar daemon already running (socket=${socket})\n`);
            return;
        }
        process.stderr.write(`[taco] sidecar daemon stale (${staleReason}); restarting\n`);
        await killWedgedDaemon(runtimeDir, socket, control, ownInstallId);
        probe = "absent";
    }
    if (probe === "wedged") {
        // The socket answers connects but no RPC response arrives across two
        // probes — the daemon is alive at the kernel level and dead at the
        // application level. Reap it and fall through to a fresh spawn, or
        // every launch from here on would attach to the same unresponsive
        // process.
        process.stderr.write(
            "[taco] sidecar daemon accepts connections but does not serve; killing it\n",
        );
        await killWedgedDaemon(runtimeDir, socket, control, ownInstallId);
    }

    // Belt-and-braces: at this point probe is narrowed to "absent".
    // A pid file pointing at a dead pid doesn't show up as "wedged" (no
    // listener) but it does mean our subsequent spawn could race with
    // cleanup. Force-reap for a deterministic baseline. Idempotent after the
    // stale/wedged kills above — their unlink leaves nothing to parse.
    await killWedgedDaemon(runtimeDir, socket, control, ownInstallId);

    const lock = await acquireStartLock(runtimeDir);
    if (!lock) {
        // Another process is mid-spawn. Wait for its daemon rather than racing
        // it to bind the same socket.
        const holder = await readStartLock(`${runtimeDir}/start.lock`);
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
            runtimeDir,
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
