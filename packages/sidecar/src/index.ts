#!/usr/bin/env tsx
/**
 * Taco Sidecar — starts a stdio NDJSON server.
 *
 * Config loading order (later overrides earlier):
 *   1. env vars (TACO_DEFAULT_MODEL, TACO_SESSIONS_ROOT, ...)
 *   2. global config: $TACO_HOME/taco.json
 *   3. CLI args (--default-model, --system-prompt, ...)
 */

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import {
    createServer as createNetServer,
    connect as netConnect,
    type Server,
    type Socket,
} from "node:net";
import { dirname, join } from "node:path";
import { sweepStaging } from "./attachments/attachmentStore.ts";
import { ConversationRouter } from "./channels/conversationRouter.ts";
import { defaultSessionsRoot, resolveConfig, THINKING_LEVELS, tacoHome } from "./config/config.ts";
import { loadExtensions } from "./extensions/index.ts";
import type { ExtensionRegistry } from "./extensions/registry.ts";
import { buildSidecarPidRecord, computeInstallId } from "./lib/installId.ts";
import { createLogger } from "./lib/logger.ts";
import { augmentProcessPath, resolveLoginShellPathCached } from "./lib/loginShellPath.ts";
import { createMemoryDreamHandler } from "./memory/dream/dreamJob.ts";
import { ProviderKeyStore } from "./runtime/models/providerKeyStore.ts";
import type { ThinkingLevel } from "./runtime/pi/types.ts";
import { sidecarVersion } from "./runtime/runtimeResources.ts";
import { defaultMemoryDreamJob, MEMORY_DREAM_COMMAND } from "./scheduler/builtinJobs.ts";
import { createJobDispatcher } from "./scheduler/dispatcher.ts";
import { JobsController } from "./scheduler/jobsController.ts";
import { Scheduler } from "./scheduler/runner.ts";
import { JobStore } from "./scheduler/store.ts";
import { ClientSinkRegistry } from "./server/clientSinkRegistry.ts";
import { ConnectionServer } from "./server/connectionServer.ts";
import { handleControlChannel } from "./server/controlChannel.ts";
import { DurablePushLog } from "./server/durablePushLog.ts";
import { NullTransport } from "./server/nullTransport.ts";
import { SidecarServer, type SidecarServerOptions } from "./server/server.ts";
import { StdioTransport } from "./server/stdioTransport.ts";
import { DEFAULT_MARKER_PATH, UpgradeOrchestrator } from "./upgrader/orchestrator.ts";

const log = createLogger("sidecar");

/** Push tails untouched this long are pruned at daemon start. */
const PUSH_TAIL_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Rotate the stderr tee target past this size; one previous file is kept. */
const STDERR_LOG_MAX_BYTES = 32 * 1024 * 1024;

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
function resolveCliConfig(args: ReturnType<typeof parseArgs>): ReturnType<typeof resolveConfig> {
    return resolveConfig({
        defaultModel: args["default-model"],
        sessionsRoot: args["sessions-root"],
        systemPrompt: args["system-prompt"],
        thinkingLevel: parseThinkingLevel(args["thinking-level"]),
        anthropicApiKey: args["anthropic-api-key"],
        openaiApiKey: args["openai-api-key"],
    });
}

async function resolveDeps(): Promise<ResolvedDeps> {
    const args = parseArgs();
    const cfg = resolveCliConfig(args);
    const providerKeyStore = new ProviderKeyStore(cfg.apiKeys ?? {});
    const extensionRegistry = await loadExtensions({
        extensions: cfg.extensions ?? [],
        disabledExtensions: cfg.disabledExtensions ?? [],
    });
    const sessionsRoot = defaultSessionsRoot(cfg.sessionsRoot);
    if (!existsSync(sessionsRoot)) {
        mkdirSync(sessionsRoot, { recursive: true });
    }
    // Staged attachments that never made it into a message. Best-effort: a
    // sweep that fails must not keep the sidecar from starting.
    void sweepStaging().catch(() => undefined);
    return { args, cfg, providerKeyStore, extensionRegistry, sessionsRoot };
}

function toSidecarOptions(deps: ResolvedDeps): SidecarServerOptions {
    return {
        sessionsRoot: deps.sessionsRoot,
        defaultModel: deps.cfg.defaultModel,
        defaultProvider: deps.cfg.defaultProvider,
        systemPrompt: deps.cfg.systemPrompt,
        defaultThinkingLevel: deps.cfg.defaultThinkingLevel,
        compaction: deps.cfg.compaction,
        memoryEnabled: deps.cfg.memoryEnabled,
        instructionsConfig: deps.cfg.instructions,
        extensionRegistry: deps.extensionRegistry,
        providerKeyStore: deps.providerKeyStore,
        customProviders: deps.cfg.customProviders,
        providerExtraModels: deps.cfg.providerExtraModels,
        providerHiddenModels: deps.cfg.providerHiddenModels,
        mcpServers: deps.cfg.mcpServers,
        channels: deps.cfg.channels,
    };
}

/** Daemon mode entry. Bound by the @taco-ai/cli launcher or directly by
 *  the Tauri UI in production (see clients/taco-desktop/src-tauri/src/lib.rs).
 *  Activated by TACO_DAEMON_MODE=1; the launcher writes TACO_SOCKET (NDJSON
 *  socket) and TACO_CONTROL_SOCKET (single-instance marker — see runDaemon).
 *
 * One SidecarServer owns every workspace and channel. Each NDJSON connection
 * owns only its handshake and transport. Disconnecting a client leaves turns
 * running on the daemon; the launcher terminates it via
 * SIGTERM (or its launchd / schtasks wrapper).
 *
 * Lifecycle invariants:
 *  - Control socket binds first as the single-instance lock; a healthy
 *    boot probe, or losing the bind race with EADDRINUSE, means another
 *    daemon is already live and we exit 0 (see runDaemon).
 *  - NDJSON binds second; failure closes + unlinks the control socket.
 *  - On clean shutdown both socket files are unlinked; the
 *    `process.on('exit')` hook is a sync fallback for crash exits.
 *  - At startup we probe the NDJSON socket path and unlink a stale
 *    ECONNREFUSED entry from a previous crash before binding.
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

/** net.Server has no closeAllConnections; explicitly destroy accepted sockets. */
function closeServer(server: Server, sockets?: Set<Socket>): Promise<void> {
    for (const socket of sockets ?? []) socket.destroy();
    return new Promise<void>((resolve) => server.close(() => resolve()));
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

type ControlProbe = "ready" | "stale" | "absent";

/** Single ping attempt against a bound control socket. "unresponsive" means
 *  the connect succeeded (kernel backlog) but no ping reply landed inside the
 *  timeout — a bare connect is NOT proof of a serving daemon. */
function pingControlOnce(path: string, timeoutMs: number): Promise<ControlProbe | "unresponsive"> {
    return new Promise((resolve) => {
        let settled = false;
        const sock = netConnect(path);
        const finish = (result: ControlProbe | "unresponsive") => {
            if (settled) return;
            settled = true;
            sock.destroy();
            resolve(result);
        };
        let buf = "";
        sock.once("connect", () => {
            sock.write(`${JSON.stringify({ method: "control.ping", id: 1 })}\n`);
        });
        sock.on("data", (chunk: Buffer) => {
            buf += chunk.toString("utf8");
            const nl = buf.indexOf("\n");
            if (nl === -1) return;
            try {
                const reply = JSON.parse(buf.slice(0, nl)) as { id?: unknown; result?: unknown };
                finish(
                    typeof reply.id === "number" && "result" in reply ? "ready" : "unresponsive",
                );
            } catch {
                finish("unresponsive");
            }
        });
        sock.once("error", (err: NodeJS.ErrnoException) => {
            if (err.code === "ECONNREFUSED") finish("stale");
            else if (err.code === "ENOENT") finish("absent");
            else finish("unresponsive");
        });
        setTimeout(() => finish("unresponsive"), timeoutMs).unref();
    });
}

/** Single-instance check for the control socket. The control listener binds
 *  before the heavy init (channels/scheduler), so during another daemon's
 *  boot window the socket is bound while its event loop may still be busy —
 *  hence 3 ping attempts before concluding. A bound-but-unresponsive daemon
 *  still maps to "ready": ownership recovery belongs to the reap layer
 *  (CLI start / desktop reap, which check the pid file's install_id); the
 *  newborn must not unlink a socket it does not own. */
async function probeControlSocket(path: string, attempts = 3): Promise<ControlProbe> {
    if (IS_UNIX && !existsSync(path)) return "absent";
    for (let attempt = 0; attempt < attempts; attempt++) {
        const result = await pingControlOnce(path, 1_000);
        if (result !== "unresponsive") return result;
        if (attempt < attempts - 1) {
            await new Promise((r) => setTimeout(r, 400));
        }
    }
    log.warn(
        `control socket at ${path} is bound but unresponsive; treating as owned by another daemon`,
    );
    return "ready";
}

async function runDaemon(
    deps: ResolvedDeps,
    socketPath: string,
    controlSocketPath: string,
): Promise<void> {
    // Claim the control socket before constructing channels, runtimes, or the
    // scheduler. A probe alone is not ownership: two daemons can both observe
    // an absent path and start expensive/replaying state before one loses the
    // bind race.
    let ndjsonServer!: Server;
    let shutdown: ((sig: string) => Promise<void>) | undefined;
    let shutdownRequestedDuringStartup = false;
    const controlSockets = new Set<Socket>();
    const clientSockets = new Set<Socket>();
    const controlServer = createNetServer((socket: Socket) => {
        controlSockets.add(socket);
        socket.once("close", () => controlSockets.delete(socket));
        handleControlChannel(socket, async () => {
            if (shutdown) {
                await shutdown("CONTROL_SHUTDOWN");
            } else {
                // The control socket is deliberately claimed before the
                // scheduler/runtime stack is ready. Honor a shutdown received
                // in that small startup window once the complete shutdown
                // routine has been installed instead of exiting halfway
                // through initialization.
                shutdownRequestedDuringStartup = true;
            }
        });
        socket.on("error", (err) => log.warn(`control socket error: ${err.message}`));
    });
    const controlState = IS_UNIX ? await probeControlSocket(controlSocketPath) : "absent";
    if (controlState === "ready") {
        log.info(`another daemon already owns ${controlSocketPath}; exiting`);
        process.exit(0);
    }
    if (controlState === "stale") {
        log.warn(`removing stale control socket at ${controlSocketPath}`);
        unlinkSocketSync(controlSocketPath);
    }
    await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
            if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
                log.info(`another daemon bound ${controlSocketPath} first; exiting`);
                process.exit(0);
            }
            reject(err);
        };
        controlServer.once("error", onError);
        controlServer.once("listening", () => {
            controlServer.removeListener("error", onError);
            // Attach the generic error listener only after the bind has
            // succeeded. Registering it before the bind would also catch the
            // expected EADDRINUSE single-instance race below and surface it as
            // a red "control server error" banner in the desktop UI, even
            // though that path deliberately exits 0 to reuse the live daemon.
            controlServer.on("error", (err) => log.error(`control server error: ${err.message}`));
            resolve();
        });
        controlServer.listen(controlSocketPath);
    });

    try {
        // One scheduler serves client requests and background invocations.
        const jobsDir = join(tacoHome(), "jobs");
        const jobStore = new JobStore(jobsDir);

        // One runtime owns workspaces, sessions, channels and sequenced events.
        // Connections only own handshakes and response transports.
        const conversationRouter = await ConversationRouter.load(tacoHome());
        const clientSinkRegistry = new ClientSinkRegistry();
        const pushLog = new DurablePushLog(join(tacoHome(), "push-log"));
        // Before any stream is touched: a tail older than this has no client
        // left that could resume from it.
        await pushLog
            .prune(PUSH_TAIL_MAX_AGE_MS)
            .then((removed) => {
                if (removed > 0) log.info(`pruned ${removed} stale push tail(s)`);
            })
            .catch((err: unknown) => log.warn(`push tail prune failed: ${String(err)}`));
        const runtime = new SidecarServer({
            ...toSidecarOptions(deps),
            resolveConfig: () => resolveCliConfig(deps.args),
            conversationRouter,
            clientSinkRegistry,
            pushLog,
        });
        // Channel/router startup failures must not block filesystem RPCs or socket binding.
        await runtime.start(new NullTransport(), deps.cfg.channels ?? []).catch((err: unknown) => {
            log.error(`runtime failed to start: ${String(err)}`);
        });

        const scheduler = new Scheduler({
            store: jobStore,
            lockDir: jobsDir,
            invoke: createJobDispatcher(
                () => runtime,
                // Pin strategy writes the created sessionId back to the job so
                // subsequent fires can attach the same session. The callback
                // here IS a write — earlier comments claimed "the dispatcher
                // never mutates the store", which was misleading once we
                // added onPinnedSessionCreated. The store is still the
                // single-writer for job JSON on disk (every write goes
                // through JobStore.mutate, whose per-id queue serialises
                // against the runner's history write and the controller's
                // update), but the dispatcher triggers that write rather
                // than leaving it implicit.
                {
                    onPinnedSessionCreated: async (jobId, sessionId) => {
                        await jobStore.mutate(jobId, (job) =>
                            job ? { ...job, pinnedSessionId: sessionId } : null,
                        );
                    },
                    builtinHandlers: new Map([
                        [MEMORY_DREAM_COMMAND, createMemoryDreamHandler(deps.providerKeyStore)],
                    ]),
                },
            ),
        });
        // Construct + mount the JobsController BEFORE scheduler.start(). Boot
        // replay fires jobs as fire-and-forget invokes: a replayed agent
        // turn can itself call jobs.* RPCs (e.g. to introspect or disable
        // its sibling jobs). If we deferred mounting until after
        // scheduler.start(), those in-flight calls would land on a server
        // whose `jobs` field is still undefined and would return an
        // opaque "jobs not mounted" error. Mounting first closes that
        // window — the controller never fires jobs of its own, so
        // construction before scheduler.start() has no risk of recursion.
        const jobsController = new JobsController(jobStore, scheduler, jobsDir);
        runtime.setJobsControl(jobsController);
        // Seed before start() so a missed nightly run replays at this boot.
        await jobsController.seedBuiltin(defaultMemoryDreamJob()).catch((err: unknown) => {
            log.error(`failed to seed the memory consolidation job: ${String(err)}`);
        });
        await scheduler.start().catch((err: unknown) => {
            log.error(`scheduler failed to start: ${String(err)}`);
        });

        // Stale-socket cleanup before we try to bind. A previous daemon that
        // crashed (kill -9 / power loss) leaves the socket file on disk; bind()
        // would fail with EADDRINUSE forever. probeNdjsonSocket → "stale" means
        // a file exists with no listener, which is exactly the recoverable case.
        const ndjsonState = IS_UNIX ? await probeNdjsonSocket(socketPath) : "absent";
        if (ndjsonState === "stale") {
            log.warn(`removing stale NDJSON socket at ${socketPath}`);
            unlinkSocketSync(socketPath);
        }

        ndjsonServer = createNetServer((socket: Socket) => {
            clientSockets.add(socket);
            socket.once("close", () => clientSockets.delete(socket));
            const transport = new StdioTransport(socket, socket);
            const connection = new ConnectionServer(runtime, transport, clientSinkRegistry);
            void connection.start().catch((err) => {
                log.error(`connection failed to start: ${String(err)}`);
                socket.destroy();
            });
            socket.on("close", () => {
                void connection
                    .stop()
                    .catch((err) => log.error(`connection stop failed: ${String(err)}`));
            });
            socket.on("error", (err) => log.error(`ndjson socket error: ${err.message}`));
        });
        ndjsonServer.on("error", (err) => log.error(`ndjson server error: ${err.message}`));

        // Control is already bound and owned. Bind NDJSON second; if it fails,
        // release the control ownership so the next launch can recover.
        await new Promise<void>((resolve, reject) => {
            ndjsonServer.once("error", (err: Error) => {
                void closeServer(controlServer, controlSockets).finally(() => {
                    unlinkSocketSync(controlSocketPath);
                    reject(err);
                });
            });
            ndjsonServer.once("listening", () => resolve());
            ndjsonServer.listen(socketPath);
        });

        log.info(
            `daemon listening ndjson=${socketPath} control=${controlSocketPath} sessionsRoot=${deps.sessionsRoot}`,
        );

        // Pid file — single source of truth for "which daemon owns this
        // runtime directory". The CLI's wedged-daemon reaper reads it on
        // every `taco start`; the desktop's reap path reads it before
        // spawning a replacement; both check `install_id` to avoid
        // killing a sibling taco install that happens to share the home.
        // Written only after both sockets are bound so a half-booted
        // process never advertises itself; removed on the shutdown/exit
        // paths below.
        //
        // The directory comes from TACO_RUNTIME_DIR, not the socket path:
        // on Windows the socket is a named pipe (`\\.\pipe\...`), whose
        // dirname is not a filesystem location. Both launchers always set
        // the env; dirname(socketPath) is the unix fallback for direct
        // invocations. `sidecar_version` lets launchers reap a stale-code
        // daemon instead of reusing it (see killWedgedDaemon / daemon_reap).
        const pidPath = join(process.env.TACO_RUNTIME_DIR ?? dirname(socketPath), "sidecar.pid");
        try {
            const installId = computeInstallId(
                process.env.TACO_SIDECAR_RESOURCES ?? "",
                tacoHome(),
            );
            const record = buildSidecarPidRecord(process.pid, installId, sidecarVersion());
            writeFileSync(pidPath, JSON.stringify(record), "utf8");
        } catch (err) {
            log.warn(`failed to write pid file ${pidPath}: ${String(err)}`);
        }

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
                // Retire from the runtime dir before exiting. The pid file is
                // how the next desktop decides whether a previous daemon
                // exists; leaving it in place across this fast path makes a
                // restarting desktop discover a daemon that stopped serving
                // the moment this handler ran, fail three control pings
                // against it, then SIGTERM it and wait out the grace period —
                // up to 5.3s of cold-start latency caused entirely by the
                // *previous* exit. See the matching rationale in the
                // SIGINT/SIGTERM path below.
                await closeServer(ndjsonServer, clientSockets);
                await closeServer(controlServer, controlSockets);
                unlinkSocketSync(socketPath);
                unlinkSocketSync(controlSocketPath);
                unlinkSocketSync(pidPath);
                process.exit(0);
            },
        });
        upgradeOrchestrator.start();

        shutdown = async (sig: string) => {
            log.info(`caught ${sig}, shutting down daemon...`);
            scheduler.stop();
            upgradeOrchestrator.stop();
            // Retire from the runtime dir FIRST, before the slow teardown below.
            // The pid file is how the next desktop decides whether a previous
            // daemon exists; leaving it in place across a multi-second shutdown
            // makes a restarting desktop discover a daemon that stopped serving
            // the moment this handler ran, fail three control pings against it,
            // then SIGTERM it and wait out the grace period — up to 5.3s of
            // cold-start latency caused entirely by the *previous* exit. Closing
            // the listeners and unlinking here means the next desktop sees no
            // pid file (NoPidFile, the fast path) and spawns immediately, while
            // this process finishes draining in the background.
            //
            // Ordering within this block matters: close the listeners before
            // unlinking, so no connection is accepted against a path that is
            // already gone. Unlinking early is also what makes it safe for the
            // next daemon to bind a fresh inode while this one is still exiting
            // — the unlinks below cannot then delete the *new* daemon's socket,
            // because they have already run.
            await closeServer(ndjsonServer, clientSockets);
            await closeServer(controlServer, controlSockets);
            unlinkSocketSync(socketPath);
            unlinkSocketSync(controlSocketPath);
            unlinkSocketSync(pidPath);
            await runtime.stop().catch((err: unknown) => {
                log.error(`runtime stop failed: ${String(err)}`);
            });
            process.exit(0);
        };
        const stopDaemon = shutdown;
        if (shutdownRequestedDuringStartup) {
            void stopDaemon("CONTROL_SHUTDOWN");
        }
        process.on("SIGINT", () => void stopDaemon("SIGINT"));
        process.on("SIGTERM", () => void stopDaemon("SIGTERM"));
        // Crash-exit fallback: async shutdown may not finish if the process is
        // dying. process.on('exit') runs synchronously after the event loop drains
        // and is the last chance to clean up before the process image is replaced.
        process.on("exit", () => {
            unlinkSocketSync(socketPath);
            unlinkSocketSync(controlSocketPath);
            unlinkSocketSync(pidPath);
        });
        // Uncaught error while a job is mid-fire: flip its `running` history
        // entry to `err` so a hung scheduler doesn't leave a permanent "still
        // running" record. A custom uncaughtException listener suppresses
        // Node's automatic exit, so persist the marks for a bounded interval
        // and then explicitly terminate non-zero. The OS reaps any leftover
        // `<id>.lock` on next start via stale cleanup in Scheduler.start().
        process.on("uncaughtException", (err) => {
            log.error(`uncaught exception: ${err?.stack ?? err}`);
            const reason = err?.message ?? "uncaughtException";
            void Promise.race([
                jobsController.markRunningAsErr(reason),
                new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
            ]).finally(() => {
                process.exitCode = 1;
                process.exit(1);
            });
        });
    } catch (err) {
        await closeServer(controlServer, controlSockets).catch(() => undefined);
        unlinkSocketSync(controlSocketPath);
        throw err;
    }
}

/**
 * Stdio entry point (unchanged for PR2). Used by `pnpm dev:sidecar` and any
 * other caller that wants to speak NDJSON directly to the sidecar's stdio
 * without going through a socket. `@taco-ai/cli/bin/taco.cjs` falls back to
 * this when TACO_DAEMON_MODE is unset.
 */
async function runStdio(deps: ResolvedDeps): Promise<void> {
    const server = new SidecarServer({
        ...toSidecarOptions(deps),
        resolveConfig: () => resolveCliConfig(deps.args),
        // Single server in this process, so it owns every stream file outright.
        pushLog: new DurablePushLog(join(tacoHome(), "push-log")),
    });
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
    if (augmentProcessPath(resolveLoginShellPathCached)) {
        log.info("augmented PATH from login shell");
    }

    // Diagnostic: macOS launches .app bundles with cwd="/" by default,
    // which means relative paths (e.g. for runtime resources) resolve
    // against /. Surface this early so the desktop log shows it.
    // Also tee stderr to ~/.taco/logs/daemon.err.log when the env var
    // points there -- launchd-managed daemons get this for free via the
    // plist's StandardErrorPath, but direct-spawned (release-mode
    // workspace_ensure) daemons would otherwise lose their stderr to a
    // captured pipe buffer in the parent.
    if (process.cwd() === "/") {
        log.warn("cwd is / (typical for .app bundles); runtime resources must use absolute paths");
    }
    if (process.env.TACO_STDERR_LOG) {
        const logPath = process.env.TACO_STDERR_LOG;
        try {
            const fs = await import("node:fs/promises");
            await fs.appendFile(
                logPath,
                `\n--- sidecar started pid=${process.pid} cwd=${process.cwd()} ${new Date().toISOString()} ---\n`,
            );
            // One long-lived append stream, NOT fs.appendFile per line.
            // appendFile does open+write+close per call and is fire-and-forget
            // here, so a burst of stderr (skill diagnostics alone emit dozens of
            // lines in one tick) puts thousands of concurrent opens in flight.
            // Each holds an fd, so the daemon hit the macOS per-process limit
            // (61440) within seconds — measured 61406 fds all pointing at this
            // one log file — while the pending promises and retained chunks grew
            // the heap past 2GB. The event loop wedged, every RPC timed out, and
            // V8 aborted at the heap limit. Worse, it self-amplified: more log
            // volume meant more fds meant more errors to log. A single stream
            // holds exactly one fd and serializes writes internally.
            const { installStderrTee } = await import("./lib/stderrTee.ts");
            // Bounded, and without `[taco:llm]` payload dumps: the desktop
            // reads those off live stderr into its opt-in llm-dump.log.
            const handle = installStderrTee(logPath, {
                maxBytes: STDERR_LOG_MAX_BYTES,
                skipPrefix: "[taco:llm]",
            });
            if (handle) {
                log.info("stderr tee active -> " + handle.targetPath);
                // process.on('exit') runs synchronously after the event loop
                // drains — last chance to flush the mirror and restore
                // process.stderr.write. Without this, the mirror stream
                // holds an fd open across process replacement, and a
                // captured-stderr parent sees Node's "process.stderr was
                // mutated" warning with no way to attribute it.
                process.once("exit", () => handle.dispose());
            }
        } catch (err) {
            log.warn("failed to set up stderr tee: " + String(err));
        }
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
