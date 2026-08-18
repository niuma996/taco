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
import {
    createServer as createNetServer,
    connect as netConnect,
    type Server,
    type Socket,
} from "node:net";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { IM_CWD_PREFIX } from "@taco-ai/protocol";
import { ChannelBindBroker } from "./channels/channelBindBroker.ts";
import { ConversationRouter } from "./channels/conversationRouter.ts";
import { ChannelRegistry } from "./channels/registry.ts";
import { defaultSessionsRoot, resolveConfig, THINKING_LEVELS, tacoHome } from "./config/config.ts";
import { loadExtensions } from "./extensions/index.ts";
import type { ExtensionRegistry } from "./extensions/registry.ts";
import { createLogger } from "./lib/logger.ts";
import { augmentProcessPath } from "./lib/loginShellPath.ts";
import { ProviderKeyStore } from "./runtime/providerKeyStore.ts";
import { createJobDispatcher } from "./scheduler/dispatcher.ts";
import { JobsController } from "./scheduler/jobsController.ts";
import { Scheduler } from "./scheduler/runner.ts";
import { JobStore } from "./scheduler/store.ts";
import { ClientSinkRegistry } from "./server/clientSinkRegistry.ts";
import { handleControlChannel } from "./server/controlChannel.ts";
import { NullTransport } from "./server/nullTransport.ts";
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

/** Tear down a listening server and any sockets it already accepted.
 *
 *  `server.close()` only stops accepting new connections; long-lived NDJSON
 *  sessions keep the event loop alive so the `close` callback never fires
 *  and the shutdown path hangs forever on its `await`. `closeAllConnections()`
 *  (Node ≥ 18.2; we're on 22) destroys accepted sockets in userspace so
 *  `close` resolves immediately. The control socket is included even
 *  though its sessions are short-lived — a client stuck mid-shutdown can
 *  wedge the callback too. The cast is needed because @types/node@22
 *  doesn't expose the method on `net.Server` (it's runtime-only). */
function closeServer(server: Server): Promise<void> {
    type Closable = Server & { closeAllConnections?: () => void };
    return new Promise<void>((resolve) => {
        (server as Closable).closeAllConnections?.();
        server.close(() => resolve());
    });
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

    // Process-level IM channel stack. Constructed once and shared with every
    // NDJSON connection's SidecarServer so a desktop disconnect cannot kill
    // inbound IM bots and only one routing.json writer exists. `imHost` is
    // the resident host that owns the channel stack — connection servers
    // forward im:// RPCs to it via dispatchRpc.
    //
    // The resident is constructed BEFORE the single-instance probe so a
    // hostile / stale probe can't race channel startup. Channel startup
    // failures are isolated: a bot failing to bind must not block the
    // socket bind or fs-workspace RPCs.
    const conversationRouter = await ConversationRouter.load(tacoHome());
    const sharedChannelStack = {
        channelRegistry: new ChannelRegistry(),
        channelBindBroker: new ChannelBindBroker(),
        conversationRouter,
    };
    // Phase 2: process-level fan-out registry. The resident uses it to push
    // IM frames to every connected desktop's NDJSON transport so an open
    // IM session view stays live (new peer messages, mid-turn updates).
    // Without this the host's emitPush would only hit NullTransport and
    // Phase 1's regression — already-open IM views going stale — would
    // remain. Each SidecarServer adds its own transport on start().
    const clientSinkRegistry = new ClientSinkRegistry();

    // Two runtimes, one process:
    //  - `imHost` owns IM workspaces + the channel stack; im:// cwd sessions
    //    run here so a desktop disconnect never kills the inbound IM bot.
    //  - `schedulerSidecar` owns fs workspaces; fs cwd sessions invoked by
    //    scheduled jobs run here so the scheduler doesn't depend on any
    //    desktop connection being up. It does NOT share the channel stack
    //    (no IM traffic) and does NOT register with clientSinkRegistry
    //    (desktop sessions don't track scheduler-generated sched-* ids).
    //
    // Both must be constructed AND started before Scheduler.start(), which
    // may fire boot-replay jobs as fire-and-forget invokes; the resolver
    // closes over both references.
    const imHost = new SidecarServer({
        ...toSharedSidecarDeps(deps),
        ...sharedChannelStack,
        clientSinkRegistry,
    });
    const schedulerSidecar = new SidecarServer({ ...toSharedSidecarDeps(deps) });
    await imHost.start(new NullTransport(), deps.cfg.channels ?? []).catch((err: unknown) => {
        log.error(`IM host failed to start: ${String(err)}`);
    });
    // `NullTransport` is no-op for open/close/send, so the scheduler
    // runtime has no remote client and no channel bots. start() still
    // wires broker/router subscriptions + command-record sweeper + the
    // transport field that getTransport() falls back to — without
    // setting it, emitPush inside job invokes would create a fresh
    // StdioTransport and write to actual stdout.
    await schedulerSidecar.start(new NullTransport(), []).catch((err: unknown) => {
        log.error(`scheduler runtime failed to start: ${String(err)}`);
    });

    const scheduler = new Scheduler({
        store: jobStore,
        lockDir: jobsDir,
        invoke: createJobDispatcher(
            (workspace) => (workspace.startsWith(IM_CWD_PREFIX) ? imHost : schedulerSidecar),
            // Pin strategy writes the created sessionId back to the job so
            // subsequent fires can attach the same session. The store stays
            // authoritative for job state; the dispatcher never mutates it.
            {
                onPinnedSessionCreated: async (jobId, sessionId) => {
                    const job = await jobStore.get(jobId);
                    if (!job) return;
                    await jobStore.save({ ...job, pinnedSessionId: sessionId });
                },
            },
        ),
    });
    await scheduler.start().catch((err: unknown) => {
        log.error(`scheduler failed to start: ${String(err)}`);
    });
    const jobsController = new JobsController(jobStore, scheduler, jobsDir);

    // Mount the controller on every SidecarServer instance that exposes
    // jobs.* RPCs. Connection servers pick it up via `sharedDeps.jobs`;
    // the two residents (imHost + schedulerSidecar) need an explicit setter
    // because their `start()` already ran before the controller existed
    // (the controller's Scheduler depends on them — see dispatch resolver).
    imHost.setJobsControl?.(jobsController);
    schedulerSidecar.setJobsControl?.(jobsController);

    const sharedDeps = {
        ...toSharedSidecarDeps(deps),
        ...sharedChannelStack,
        jobs: jobsController,
        imHost,
        clientSinkRegistry,
    };

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
            await closeServer(ndjsonServer);
            await closeServer(controlServer);
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

    // PR4 upgrade orchestrator: read the marker on boot + every 6h; when a
    // pending upgrade targeting THIS install (marker.live_dir === our own
    // TACO_SIDECAR_RESOURCES root) is staged, shut down so the owner can run
    // `taco upgrade --apply`. Constructed AFTER the servers are bound: the
    // shutdown closure captures them, and a marker present at boot used to
    // fire the closure before the `const` declarations were reached (TDZ).
    const upgradeOrchestrator = new UpgradeOrchestrator({
        markerPath: DEFAULT_MARKER_PATH,
        liveDir: process.env.TACO_SIDECAR_RESOURCES,
        requestShutdown: async (reason) => {
            log.info(`upgrade orchestrator: ${reason}; shutting down daemon`);
            await closeServer(ndjsonServer);
            await closeServer(controlServer);
            unlinkSocketSync(socketPath);
            unlinkSocketSync(controlSocketPath);
            process.exit(0);
        },
    });
    upgradeOrchestrator.start();

    const shutdown = async (sig: string) => {
        log.info(`caught ${sig}, shutting down daemon...`);
        scheduler.stop();
        upgradeOrchestrator.stop();
        // Stop the resident first so its channels cancel before we tear down
        // the socket listeners — long-poll / webhook handlers otherwise keep
        // the event loop alive across process.exit.
        await imHost.stop().catch((err: unknown) => {
            log.error(`IM host stop failed: ${String(err)}`);
        });
        // Scheduler runtime last: any in-flight job invokes have already
        // been cancelled by scheduler.stop() above, so tearing this down
        // only reclaims the fs workspaces the scheduler built. NullTransport
        // close is a no-op; the value of stop() is the workspaceMap dispose.
        await schedulerSidecar.stop().catch((err: unknown) => {
            log.error(`scheduler runtime stop failed: ${String(err)}`);
        });
        await closeServer(ndjsonServer);
        await closeServer(controlServer);
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
    // Uncaught error while a job is mid-fire: flip its `running` history
    // entry to `err` so a hung scheduler doesn't leave a permanent "still
    // running" record. We deliberately don't rethrow — Node prints the
    // stack trace and exits with code 1; the marks are best-effort and
    // the OS reaps any leftover `<id>.lock` on next start via stale
    // cleanup in Scheduler.start().
    process.on("uncaughtException", (err) => {
        log.error(`uncaught exception: ${err?.stack ?? err}`);
        void jobsController.markRunningAsErr(err?.message ?? "uncaughtException");
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
    // Recover the user's real PATH before anything spawns a subprocess.
    // Under launchd / GUI launch the inherited PATH is the minimal
    // `/usr/bin:/bin:...`; agent shell commands (mmx, etc.) installed in
    // nvm/Homebrew dirs would be invisible. Agents inherit process.env, so
    // fixing it here covers both daemon and stdio modes.
    if (augmentProcessPath()) {
        log.info("augmented PATH from login shell");
    }

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
