#!/usr/bin/env tsx
/**
 * Taco Sidecar — starts a stdio NDJSON server.
 *
 * Config loading order (later overrides earlier):
 *   1. env vars (TACO_DEFAULT_MODEL, TACO_SESSIONS_ROOT, ...)
 *   2. global config: $TACO_HOME/taco.json
 *   3. CLI args (--default-model, --system-prompt, ...)
 */

import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer as createNetServer, connect as netConnect, type Socket } from "node:net";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { defaultSessionsRoot, resolveConfig, THINKING_LEVELS, tacoHome } from "./config/config.ts";
import { loadExtensions } from "./extensions/index.ts";
import type { ExtensionRegistry } from "./extensions/registry.ts";
import { createLogger } from "./lib/logger.ts";
import { ProviderKeyStore } from "./runtime/providerKeyStore.ts";
import { createJobDispatcher } from "./scheduler/dispatcher.ts";
import { JobsController } from "./scheduler/jobsController.ts";
import { Scheduler } from "./scheduler/runner.ts";
import { JobStore } from "./scheduler/store.ts";
import { handleControlChannel } from "./server/controlChannel.ts";
import { type SharedSidecarDeps, SidecarServer, startServer } from "./server/server.ts";
import { StdioTransport } from "./server/stdioTransport.ts";
import { DEFAULT_MARKER_PATH, UpgradeOrchestrator } from "./upgrader/orchestrator.ts";

const log = createLogger("sidecar");

function parseThinkingLevel(raw: string | undefined): ThinkingLevel | undefined {
    if (raw === undefined) return undefined;
    if (!THINKING_LEVELS.has(raw as ThinkingLevel)) {
        throw new Error(
            `invalid --thinking-level: ${JSON.stringify(raw)} (expected one of ${[...THINKING_LEVELS].join(", ")})`,
        );
    }
    return raw as ThinkingLevel;
}

function parseArgs() {
    const args: Record<string, string> = {};
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith("--")) {
            const key = a.slice(2);
            const next = argv[i + 1];
            if (next && !next.startsWith("--")) {
                args[key] = next;
                i++;
            } else {
                args[key] = "true";
            }
        }
    }
    return args;
}

interface ResolvedDeps {
    args: ReturnType<typeof parseArgs>;
    cfg: ReturnType<typeof resolveConfig>;
    providerKeyStore: ProviderKeyStore;
    extensionRegistry?: ExtensionRegistry;
    sessionsRoot: string;
}

/**
 * Resolve config + load extensions + ensure sessions dir. Shared between the
 * stdio entry point and the daemon-mode socket entry point — both code paths
 * need the same shared state, only the transport binding differs.
 */
async function resolveDeps(): Promise<ResolvedDeps> {
    const args = parseArgs();
    const cfg = resolveConfig({
        defaultModel: args["default-model"],
        sessionsRoot: args["sessions-root"],
        systemPrompt: args["system-prompt"],
        thinkingLevel: parseThinkingLevel(args["thinking-level"]),
        anthropicApiKey: args["anthropic-api-key"],
        openaiApiKey: args["openai-api-key"],
    });
    const providerKeyStore = new ProviderKeyStore(cfg.apiKeys ?? {});
    const extensionRegistry = await loadExtensions({
        extensions: cfg.extensions ?? [],
        disabledExtensions: cfg.disabledExtensions ?? [],
    });
    const sessionsRoot = defaultSessionsRoot(cfg.sessionsRoot);
    if (!existsSync(sessionsRoot)) {
        mkdirSync(sessionsRoot, { recursive: true });
    }
    return { args, cfg, providerKeyStore, extensionRegistry, sessionsRoot };
}

function toSharedSidecarDeps(deps: ResolvedDeps): SharedSidecarDeps {
    return {
        sessionsRoot: deps.sessionsRoot,
        defaultModel: deps.cfg.defaultModel,
        defaultProvider: deps.cfg.defaultProvider,
        systemPrompt: deps.cfg.systemPrompt,
        defaultThinkingLevel: deps.cfg.defaultThinkingLevel,
        compaction: deps.cfg.compaction,
        memoryEnabled: deps.cfg.memoryEnabled,
        extensionRegistry: deps.extensionRegistry,
        providerKeyStore: deps.providerKeyStore,
        customProviders: deps.cfg.customProviders,
        mcpServers: deps.cfg.mcpServers,
        channels: deps.cfg.channels,
    };
}

/** Daemon mode entry. Bound by the @taco-ai/cli launcher (PR2) or directly
 *  by the Tauri UI in production (see clients/taco-desktop/src-tauri/src/lib.rs).
 *
 * Activated by TACO_DAEMON_MODE=1; the launcher writes:
 *   TACO_SOCKET          — NDJSON socket (Unix path or \\.\pipe\taco-sidecar)
 *   TACO_CONTROL_SOCKET  — control socket; also this daemon's single-instance
 *                          marker (see runDaemon)
 *
 * Each NDJSON socket connection gets its own SidecarServer so workspace state,
 * channels, and the initialize handshake are scoped per UI rather than shared.
 * The daemon keeps running across disconnects — the launcher is responsible
 * for terminating it via SIGTERM (or PR3's launchd / schtasks wrapper).
 *
 * Lifecycle invariants (PR2 review):
 *  - Control socket binds first as the single-instance lock; a healthy probe
 *    of it at boot, or losing the bind race with EADDRINUSE, means another
 *    daemon is already live and we exit 0 (see runDaemon).
 *  - NDJSON binds second; failure closes + unlinks the control socket so we
 *    don't leave a half-running daemon.
 *  - On clean shutdown (control.shutdown / SIGTERM / SIGINT / stdin EOF) both
 *    socket files are unlinked so the next start finds no stale entry. The
 *    `process.on('exit')` hook is a synchronous fallback for crash exits where
 *    the async shutdown didn't run — sync unlink is the only thing Node
 *    allows in that phase.
 *  - At startup we probe the NDJSON socket path: if a file exists but
 *    `connect()` fails with ECONNREFUSED it's a stale entry from a previous
 *    crash, so we unlink it before binding. Without this the next start hits
 *    EADDRINUSE and exits.
 */

const IS_UNIX = process.platform !== "win32";

/** Synchronously unlink a Unix socket path, ignoring ENOENT. No-op on
 *  Windows (named pipes aren't filesystem entries). Registered on
 *  `process.on('exit')` because async cleanup doesn't run after a crash. */
function unlinkSocketSync(path: string): void {
    if (!IS_UNIX) return;
    try {
        unlinkSync(path);
    } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== "ENOENT") {
            // Best-effort cleanup; the OS will GC the inode when the fd closes.
            process.stderr.write(`[taco-sidecar] unlink ${path} failed: ${String(err)}\n`);
        }
    }
}

/** Connect-probe the NDJSON socket path. Returns true if a listener is alive.
 *  Used at startup to distinguish "no daemon yet" (file missing or connection
 *  refused) from "stale socket file from a crashed daemon" (file exists,
 *  ECONNREFUSED) — the latter gets unlinked so bind() below succeeds. */
async function probeNdjsonSocket(path: string): Promise<"ready" | "stale" | "absent"> {
    if (IS_UNIX && !existsSync(path)) return "absent";
    return new Promise((resolve) => {
        const sock = netConnect(path);
        const finish = (result: "ready" | "stale" | "absent") => {
            sock.destroy();
            resolve(result);
        };
        sock.once("connect", () => finish("ready"));
        sock.once("error", (err: NodeJS.ErrnoException) => {
            if (err.code === "ECONNREFUSED") finish("stale");
            else finish("absent");
        });
        // Defensive: if neither event fires within 1s, treat as absent and move on.
        setTimeout(() => finish("absent"), 1_000).unref();
    });
}

async function runDaemon(
    deps: ResolvedDeps,
    socketPath: string,
    controlSocketPath: string,
): Promise<void> {
    // PR4: scheduler boots once per process; every per-connection
    // SidecarServer shares the same JobsController so jobs.create/update/
    // delete mutate the single process-wide scheduler.
    const jobsDir = join(tacoHome(), "jobs");
    const jobStore = new JobStore(jobsDir);
    const schedulerSidecar = new SidecarServer({ ...toSharedSidecarDeps(deps) });
    const scheduler = new Scheduler({
        store: jobStore,
        lockDir: jobsDir,
        invoke: createJobDispatcher(schedulerSidecar),
    });
    await scheduler.start().catch((err: unknown) => {
        log.error(`scheduler failed to start: ${String(err)}`);
    });
    const jobsController = new JobsController(jobStore, scheduler, jobsDir);
    const sharedDeps = { ...toSharedSidecarDeps(deps), jobs: jobsController };

    // PR4 upgrade orchestrator: read the marker on boot + every 6h; when
    // a pending upgrade is staged, ask the host to shut down so the UI's
    // reconnect loop can run `taco upgrade --apply`. The shutdown helper
    // here captures `ndjsonServer`/`controlServer`/`socketPath`/
    // `controlSocketPath` from the enclosing scope.
    const upgradeOrchestrator = new UpgradeOrchestrator({
        markerPath: DEFAULT_MARKER_PATH,
        requestShutdown: async (reason) => {
            log.info(`upgrade orchestrator: ${reason}; shutting down daemon`);
            await new Promise<void>((resolve) => ndjsonServer.close(() => resolve()));
            await new Promise<void>((resolve) => controlServer.close(() => resolve()));
            unlinkSocketSync(socketPath);
            unlinkSocketSync(controlSocketPath);
            process.exit(0);
        },
    });
    upgradeOrchestrator.start();

    // The control socket doubles as the single-instance marker. A healthy
    // listener means another daemon already owns this $TACO_HOME, which is a
    // normal outcome (launchd RunAtLoad + a desktop-initiated `taco start` can
    // both fire). Exit 0 so launchd's KeepAlive.SuccessfulExit=false does not
    // treat it as a crash and restart us in a loop. Checked before any
    // unlinkSocketSync call so we never touch a live daemon's socket files.
    const controlState = IS_UNIX ? await probeNdjsonSocket(controlSocketPath) : "absent";
    if (controlState === "ready") {
        log.info(`another daemon already owns ${controlSocketPath}; exiting`);
        process.exit(0);
    }
    if (controlState === "stale") {
        log.warn(`removing stale control socket at ${controlSocketPath}`);
        unlinkSocketSync(controlSocketPath);
    }

    // Stale-socket cleanup before we try to bind. A previous daemon that
    // crashed (kill -9 / power loss) leaves the socket file on disk; bind()
    // would fail with EADDRINUSE forever. probeNdjsonSocket → "stale" means
    // a file exists with no listener, which is exactly the recoverable case.
    const ndjsonState = IS_UNIX ? await probeNdjsonSocket(socketPath) : "absent";
    if (ndjsonState === "stale") {
        log.warn(`removing stale NDJSON socket at ${socketPath}`);
        unlinkSocketSync(socketPath);
    }

    const ndjsonServer = createNetServer((socket: Socket) => {
        const transport = new StdioTransport(socket, socket);
        const started = startServer(sharedDeps, transport);
        started.ready.catch((err) => {
            log.error(`connection failed to start: ${err?.stack ?? err}`);
            socket.destroy();
        });
        socket.on("close", () => {
            started.stop().catch((err) => log.error(`stop failed: ${err?.stack ?? err}`));
        });
        socket.on("error", (err) => log.error(`ndjson socket error: ${err.message}`));
    });
    ndjsonServer.on("error", (err) => log.error(`ndjson server error: ${err.message}`));

    const controlServer = createNetServer((socket: Socket) => {
        // Each control client is short-lived (one ping, maybe a shutdown);
        // handleControlChannel owns its own readline + reply frame, and the
        // socket ends when the client ends. control.shutdown triggers our
        // own graceful shutdown via the callback below.
        handleControlChannel(socket, async () => {
            log.info("control.shutdown received, stopping daemon...");
            await new Promise<void>((resolve) => ndjsonServer.close(() => resolve()));
            await new Promise<void>((resolve) => controlServer.close(() => resolve()));
            unlinkSocketSync(socketPath);
            unlinkSocketSync(controlSocketPath);
            process.exit(0);
        });
        socket.on("error", (err) => log.warn(`control socket error: ${err.message}`));
    });
    controlServer.on("error", (err) => log.error(`control server error: ${err.message}`));

    // Atomic dual-bind: control first (it's the single-instance marker probed
    // above), then NDJSON. If NDJSON bind fails, roll back the control bind +
    // unlink the control socket so we don't leave a half-running daemon that
    // the next launcher thinks is live.
    await new Promise<void>((resolve, reject) => {
        const onControlError = (err: Error) => {
            ndjsonServer.removeListener("error", onNdjsonError);
            // Lost the bind race to a daemon that came up between our probe and
            // this bind. Same reasoning as the probe above: normal outcome, exit
            // 0. Do NOT unlink — the socket file belongs to the winner now.
            if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
                log.info(`another daemon bound ${controlSocketPath} first; exiting`);
                process.exit(0);
            }
            reject(err);
        };
        const onNdjsonError = (err: Error) => {
            controlServer.removeListener("error", onControlError);
            reject(err);
        };
        controlServer.once("error", onControlError);
        ndjsonServer.once("error", onNdjsonError);
        controlServer.once("listening", () => {
            ndjsonServer.once("listening", () => resolve());
            ndjsonServer.once("error", (err: Error) => {
                controlServer.close(() => {
                    unlinkSocketSync(controlSocketPath);
                    reject(err);
                });
            });
            ndjsonServer.listen(socketPath);
        });
        controlServer.listen(controlSocketPath);
    });

    log.info(
        `daemon listening ndjson=${socketPath} control=${controlSocketPath} sessionsRoot=${deps.sessionsRoot}`,
    );

    const shutdown = async (sig: string) => {
        log.info(`caught ${sig}, shutting down daemon...`);
        scheduler.stop();
        upgradeOrchestrator.stop();
        await new Promise<void>((resolve) => ndjsonServer.close(() => resolve()));
        await new Promise<void>((resolve) => controlServer.close(() => resolve()));
        unlinkSocketSync(socketPath);
        unlinkSocketSync(controlSocketPath);
        process.exit(0);
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    // Stdio is closed by the launcher (we don't read it in daemon mode), but a
    // premature close still means "the parent went away, exit now".
    process.stdin.on("end", () => void shutdown("STDIN_EOF"));
    // Crash-exit fallback: async shutdown may not finish if the process is
    // dying. process.on('exit') runs synchronously after the event loop drains
    // and is the last chance to clean up before the process image is replaced.
    process.on("exit", () => {
        unlinkSocketSync(socketPath);
        unlinkSocketSync(controlSocketPath);
    });
}

/**
 * Stdio entry point (unchanged for PR2). Used by `pnpm dev:sidecar` and any
 * other caller that wants to speak NDJSON directly to the sidecar's stdio
 * without going through a socket. `@taco-ai/cli/bin/taco.cjs` falls back to
 * this when TACO_DAEMON_MODE is unset.
 */
async function runStdio(deps: ResolvedDeps): Promise<void> {
    const server = new SidecarServer(toSharedSidecarDeps(deps));
    void server.start();

    const shutdown = async (sig: string) => {
        log.info(`caught ${sig}, shutting down...`);
        try {
            await server.stop();
        } finally {
            process.exit(0);
        }
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    // Tauri closes stdin to ask for graceful shutdown; without this handler
    // the process would block on readline until SIGKILL.
    process.stdin.on("end", () => void shutdown("STDIN_EOF"));

    log.info(
        `listening on stdio. sessionsRoot=${deps.sessionsRoot}, agentConfig=${tacoHome()}/taco.json`,
    );
}

/**
 * Main entry point: resolves config, wires extensions, ensures sessions directory,
 * then branches on TACO_DAEMON_MODE. The shared `resolveDeps` step keeps config
 * loading order (env vars / $TACO_HOME/taco.json / CLI args) identical across modes.
 */
async function main(): Promise<void> {
    const deps = await resolveDeps();

    if (process.env.TACO_DAEMON_MODE === "1") {
        const socketPath = process.env.TACO_SOCKET;
        const controlSocketPath = process.env.TACO_CONTROL_SOCKET;
        if (!socketPath || !controlSocketPath) {
            throw new Error(
                "TACO_DAEMON_MODE=1 requires TACO_SOCKET and TACO_CONTROL_SOCKET env vars",
            );
        }
        await runDaemon(deps, socketPath, controlSocketPath);
        return;
    }

    await runStdio(deps);
}

main().catch((err) => {
    log.error(`fatal: ${err?.stack ?? err}`);
    process.exit(1);
});
