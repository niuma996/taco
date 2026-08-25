/**
 * TacoClient (Tauri-flavored) — high-level API built on sidecar.ts for the
 * Tauri environment.
 *
 * Extends TacoClientBase (shared dispatcher / buffer / typed RPC injection);
 * only implements transport: send via Tauri invoke('workspace_send') +
 * listen('sidecar-event').
 */

import {
    CURRENT_SESSION_FORMAT_VERSION,
    isCompatibleSidecarProtocol,
    PushMethods,
    type RpcRequest,
    SIDECAR_PROTOCOL_VERSION,
    type WorkspaceId,
} from "@taco-ai/protocol";
import { RPC, TacoClientBase } from "@taco-ai/shared";
import { type EpochTransition, SessionEpochs } from "./sessionEpoch";
import {
    defaultSidecarClient,
    type SidecarClient,
    type SidecarExit,
    type SidecarFrame,
    type SidecarSpawnOptions,
} from "./sidecar";
import { SidecarEpochs } from "./sidecarEpoch";

/** Payload delivered to `onSessionEpochChanged` listeners.
 *  Fires per (workspace, sessionId) transition; "replaced" is the
 *  operationally interesting case — it means the daemon process owning
 *  this session changed (typical on daemon restart; rare on upgrade
 *  swap mid-session). */
export interface SessionEpochEvent {
    workspace: WorkspaceId;
    sessionId: string;
    transition: EpochTransition;
}

export interface TacoClientOptions {
    sidecar?: SidecarClient;
    /** Upper bound for an unanswered RPC. Long-running prompts may override this at construction. */
    rpcTimeoutMs?: number;
}

interface Readiness {
    promise: Promise<void>;
    resolve: () => void;
    reject: (reason: Error) => void;
}

// The 20 typed methods are injected at construction by the base class's
// createTypedRpc via Object.assign; the TS type is visible through interface
// merging. See TacoClientBase for details.
export interface TacoClient extends TacoClientBase {}

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: see interface comment above
export class TacoClient extends TacoClientBase {
    private rpcSeq = 0;
    private unlisten?: () => void;
    private unlistenExit?: () => void;
    /** cwds ensured via `start()` — reused for process-level RPC + exit fan-out.
     * Single process means all cwds share one channel; this just tracks which
     * workspaces have been started. */
    private readonly ensuredCwds = new Set<WorkspaceId>();
    private readonly sidecar: SidecarClient;
    private readonly rpcTimeoutMs: number;
    /**
     * Tracks whether the sidecar's `initialize` handshake has completed in this
     * process. Reset whenever the underlying sidecar exits (handleExit /
     * dispose). Server-side `not_initialized` guard rejects every RPC except
     * `initialize` while this is false, so `start(cwd)` awaits it before
     * returning. The initialize response is also the process identity source:
     * `instanceId` change ⇒ daemon replaced ⇒ epoch reset.
     */
    private processInitialization?: Readiness;
    private processInitialized = false;
    /** The Readiness instance for which initialize has already been sent.
     * Concurrent start(cwd) callers can both see `processInitialized === false`
     * before the response lands; only one initialize request may be in flight
     * for a process handshake. */
    private initializeAttempt?: Readiness;
    /**
     * Cwd the most recent `ensureWorkspace` was called with. Used as a fallback
     * channel for the `initialize` handshake before the first workspace is
     * fully added to `ensuredCwds` — `callProcess` rejects when nothing is
     * ensured, and the handshake cannot wait for that.
     */
    private pendingProcessCwd: WorkspaceId | undefined;
    /** PR4: cwd the last `start(cwd)` call used. Persists across `sidecar-exited`
     *  events so the reconnect loop knows which workspace to re-ensure.
     *  Distinct from `pendingProcessCwd` (cleared on exit) and from
     *  `ensuredCwds` (cleared on exit so a fresh handshake can run). */
    private reconnectCwd: WorkspaceId | undefined;
    /** PR4: set while a reconnect is in flight so a second `sidecar-exited`
     *  event during the same disconnect storm doesn't schedule a parallel
     *  reconnect (which would race on the shared handshake). */
    private reconnectInFlight = false;
    private readonly epochs = new SidecarEpochs();
    private readonly epochChangeHandlers = new Set<(workspace: WorkspaceId) => void>();
    /** Most recent instanceId observed on the initialize response; the tag
     *  SessionEpochs stamps every Attached push with so a daemon restart can
     *  fire synthetic "replaced" transitions for every tracked session. */
    private currentInstanceId: string | undefined;
    private readonly sessionEpochs = new SessionEpochs();
    private readonly sessionEpochChangeHandlers = new Set<(event: SessionEpochEvent) => void>();

    constructor(opts: TacoClientOptions = {}) {
        // Tauri side stays silent on bad frames; only the Node client surfaces them.
        super();
        this.sidecar = opts.sidecar ?? defaultSidecarClient();
        this.rpcTimeoutMs = opts.rpcTimeoutMs ?? 300_000;
    }

    protected makeDispatch() {
        return {
            call: <TParams, TResult>(
                method: string,
                workspace: WorkspaceId,
                params: TParams,
            ): Promise<TResult> => this.call<TParams, TResult>(workspace, method, params),
            callProcess: <TParams, TResult>(method: string, params: TParams): Promise<TResult> =>
                this.callProcess<TParams, TResult>(method, params),
        };
    }

    /** Start: ensure workspace + subscribe to sidecar-event.
     *
     * `options.debugMode` is passed to Rust to decide whether to inject
     * TACO_DEBUG_LLM_PAYLOAD=1 (spawn-time env, invisible to sidecar runtime).
     */
    async start(cwd: WorkspaceId, options?: SidecarSpawnOptions): Promise<void> {
        await this.ensureListeners();
        if (this.ensuredCwds.has(cwd)) return;
        // Set the handshake fallback channel BEFORE awaiting ensureWorkspace —
        // runInitialize runs concurrently with other start() callers and reads
        // this field to find a transport channel.
        this.pendingProcessCwd = cwd;
        // PR4: remember the cwd so a sidecar-exited event can reconnect.
        this.reconnectCwd = cwd;
        const initialization = this.createProcessInitialization();
        try {
            await this.sidecar.ensureWorkspace(cwd, options);
            // The initialize handshake doubles as the readiness wait: the
            // response proves the daemon is serving, carries its protocol
            // version, and identifies the process (instanceId).
            if (!this.processInitialized) void this.runInitialize();
            await this.awaitInitialization(initialization);
            this.ensuredCwds.add(cwd);
            this.pendingProcessCwd = undefined;
        } catch (error) {
            // Settle explicitly so a concurrent start() awaiting the shared
            // handshake fails now instead of on its own 10s timeout.
            this.processInitialization?.reject(
                error instanceof Error ? error : new Error(String(error)),
            );
            this.processInitialization = undefined;
            this.initializeAttempt = undefined;
            this.pendingProcessCwd = undefined;
            throw error;
        }
    }

    async dispose(): Promise<void> {
        if (this.unlisten) this.unlisten();
        this.unlisten = undefined;
        if (this.unlistenExit) this.unlistenExit();
        this.unlistenExit = undefined;
        this.rejectAllPending(new Error("client disposed"));
        // Symmetric with handleExit: an in-flight handshake gets no response
        // after dispose, so settle it rather than leaving awaiters on their
        // timeout. createProcessInitialization attaches a no-op catch, so this
        // is safe even when nobody is awaiting.
        this.processInitialization?.reject(new Error("client disposed"));
        this.processInitialization = undefined;
        this.initializeAttempt = undefined;
        this.processInitialized = false;
        this.pendingProcessCwd = undefined;
        this.ensuredCwds.clear();
        this.epochs.clearAll();
        // disposeAll SIGTERMs on the Rust side, with SIGKILL after 1s as fallback.
        await this.sidecar.disposeAll();
    }

    /** Fires before pushes from a replacement sidecar instance enter the dispatcher. */
    onWorkspaceEpochChanged(handler: (workspace: WorkspaceId) => void): () => void {
        this.epochChangeHandlers.add(handler);
        return () => this.epochChangeHandlers.delete(handler);
    }

    /** Pull — registers pending via the dispatcher. */
    async call<TParams = unknown, TResult = unknown>(
        workspace: WorkspaceId,
        method: string,
        params: TParams,
    ): Promise<TResult> {
        const id = `r${++this.rpcSeq}_${Date.now()}`;
        const req: RpcRequest<TParams> = { id, commandId: id, method, params };
        // Register pending before send: if the server responds very fast, the
        // response frame could arrive before registerPending and be dropped as
        // unknownFrame. Push frames don't clear pending; this order only guards
        // the response-vs-register race.
        const promise = this.dispatcher.registerPending(id, workspace) as Promise<TResult>;
        const timeout = setTimeout(() => {
            this.dispatcher.rejectPending(
                id,
                new Error(`RPC timeout after ${this.rpcTimeoutMs}ms: ${method}`),
            );
        }, this.rpcTimeoutMs);
        try {
            await this.sidecar.send(workspace, req as unknown as object);
        } catch (error) {
            this.dispatcher.rejectPending(
                id,
                error instanceof Error ? error : new Error(String(error)),
            );
        }
        return (await promise.finally(() => clearTimeout(timeout))) as TResult;
    }

    /**
     * Process-level RPC — not bound to any specific workspace (settings.get /
     * settings.write). Reuses any ensured cwd as the transport channel (single
     * sidecar instance routes arbitrarily). Split from `call()` to avoid leaking
     * transport details to every caller.
     *
     * Public to allow adding more process-level RPCs (workspace.list, etc.).
     */
    public async callProcess<TParams = unknown, TResult = unknown>(
        method: string,
        params: TParams,
    ): Promise<TResult> {
        // Only fully-started workspaces count. `pendingProcessCwd` is
        // deliberately NOT consulted here — it exists solely for the
        // pre-readiness `initialize` handshake (see runInitialize), and
        // honouring it would weaken this method's contract from "a workspace
        // is started" to "ensureWorkspace was once called".
        const fallback = this.ensuredCwds.values().next().value as WorkspaceId | undefined;
        if (!fallback) {
            throw new Error(
                `cannot send "${method}" before any workspace is started; call client.start(cwd) first`,
            );
        }
        return this.call<TParams, TResult>(fallback, method, params);
    }

    private async ensureListeners(): Promise<void> {
        if (!this.unlisten) {
            this.unlisten = await this.sidecar.onPush((frame) => {
                this.observeSessionLifecycle(frame);
                this.buffer.push(`${frame.line}\n`);
            });
        }
        if (!this.unlistenExit) {
            this.unlistenExit = await this.sidecar.onExit((exit) => this.handleExit(exit));
        }
    }

    /**
     * Mirror of the old hello-wait for the `initialize` handshake. Concurrent
     * starts share one promise; failed handshakes (server returning
     * `incompatible_protocol`) reject it so subsequent starts do not silently
     * succeed.
     */
    private createProcessInitialization(): Readiness {
        if (this.processInitialized) {
            return { promise: Promise.resolve(), resolve: () => {}, reject: () => {} };
        }
        if (this.processInitialization) return this.processInitialization;
        let resolve!: () => void;
        let reject!: (reason: Error) => void;
        const promise = new Promise<void>((resolvePromise, rejectPromise) => {
            resolve = resolvePromise;
            reject = rejectPromise;
        });
        // Several paths reject this promise (handleExit, runInitialize,
        // dispose) and any of them can fire when no
        // start() is awaiting — e.g. a process death after start() resolved.
        // A no-op catch keeps those rejections from surfacing as
        // unhandledRejection; real awaiters still observe the error.
        promise.catch(() => {});
        this.processInitialization = { promise, resolve, reject };
        return this.processInitialization;
    }

    private async awaitInitialization(initialization: Readiness): Promise<void> {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                initialization.promise,
                new Promise<never>((_, reject) => {
                    timeout = setTimeout(
                        () => reject(new Error("sidecar initialize timeout")),
                        10_000,
                    );
                }),
            ]);
        } finally {
            if (timeout) clearTimeout(timeout);
        }
    }

    /**
     * Parse a push frame for session-lifecycle events and update the
     * SessionEpochs tracker. Called from the onPush listener, so the parse
     * cost is paid once per frame.
     *
     * Events we care about:
     *   - session.attached   -> observe (workspace, sessionId, currentInstanceId)
     *   - session.detached   -> forget (session is no longer live on this daemon)
     *   - session.deleted    -> forget (same as detached -- the session is gone)
     *
     * All other push methods are ignored: tool_call_start, session.event,
     * etc. carry sessionId but their lifecycle is owned by SessionCursor /
     * the reducer, not by SessionEpochs. The latter only cares about
     * "is this session still attached on this daemon instance?" */
    private observeSessionLifecycle(frame: SidecarFrame): void {
        if (this.currentInstanceId === undefined) return;
        let parsed: { method?: unknown; workspace?: unknown; session?: unknown };
        try {
            parsed = JSON.parse(frame.line) as typeof parsed;
        } catch {
            return;
        }
        const method = parsed.method;
        const workspace = parsed.workspace;
        const session = parsed.session;
        if (typeof workspace !== "string" || typeof session !== "string") return;
        if (method === PushMethods.Attached) {
            const transition = this.sessionEpochs.observe(
                workspace,
                session,
                this.currentInstanceId,
            );
            // We don't fire handlers for "new" / "unchanged" by default --
            // the lifecycle push (Attached) already drives the UI via the
            // reducer. Only "replaced" is interesting here: it means the
            // session is alive on a *new* daemon instance while the
            // UI's existing state is for the old one (e.g. upgrade swap).
            if (transition === "replaced") {
                this.emitSessionEpoch(workspace, session, "replaced");
            }
            return;
        }
        if (method === PushMethods.Detached || method === PushMethods.SessionDeleted) {
            this.sessionEpochs.forget(workspace, session);
        }
    }

    /** Fire `onSessionEpochChanged` for one (workspace, sessionId, transition).
     *  Public-ish: called both from the "replaced" sweep in runInitialize and
     *  from observeSessionLifecycle for live transitions. */
    private emitSessionEpoch(
        workspace: string,
        sessionId: string,
        transition: EpochTransition,
    ): void {
        for (const handler of this.sessionEpochChangeHandlers) {
            try {
                handler({ workspace, sessionId, transition });
            } catch (err) {
                console.error("[taco] session-epoch handler threw", err);
            }
        }
    }

    /**
     * Sends a single `initialize` request for the current sidecar process.
     * On success, flips `processInitialized` and resolves the shared
     * initialization promise. On failure (incompatible protocol / timeout),
     * rejects the shared promise so concurrent `start(cwd)` callers fail too.
     */
    private async runInitialize(): Promise<void> {
        // If the handshake already succeeded for this process, there is no work
        // to do — even if a new workspace's start() called us. The epoch
        // replacement path resets `processInitialized` to false explicitly.
        if (this.processInitialized) {
            return;
        }
        const initialization = this.createProcessInitialization();
        // Concurrent start(cwd) callers can all reach this point before the
        // response lands; guard the actual request separately from the shared
        // promise so only one initialize is in flight.
        if (this.initializeAttempt === initialization) {
            return;
        }
        const fallback = this.pendingProcessCwd ?? this.ensuredCwds.values().next().value;
        if (!fallback) {
            // No transport channel yet — start() will surface the failure via
            // its own awaitInitialization timeout.
            return;
        }
        this.initializeAttempt = initialization;
        // Send the `initialize` request directly via the dispatcher so this
        // file owns the pending-promise chain end-to-end. Using the typed
        // `client.initialize` wrapper would hand the promise to two consumers
        // (runInitialize's await + typedRpc's internal await) and any
        // dispose-time rejection on the dispatcher could escape as an
        // unhandledRejection. Sending it ourselves lets us attach a catch
        // exactly once before any await.
        const id = `init_${++this.rpcSeq}_${Date.now()}`;
        const req: RpcRequest = {
            id,
            commandId: id,
            method: RPC.initialize,
            params: {
                protocolVersion: {
                    major: SIDECAR_PROTOCOL_VERSION.major,
                    minor: SIDECAR_PROTOCOL_VERSION.minor,
                },
                clientCapabilities: {},
            },
        };
        const promise = this.dispatcher.registerPending(id, fallback) as Promise<{
            serverVersion: string;
            serverCapabilities: { methods: string[]; pushes: string[] };
            protocolVersion: { major?: unknown; minor?: unknown };
            sessionFormatVersion: number;
            instanceId?: unknown;
        }>;
        // Attach the catch immediately so a dispose-time rejection never
        // escapes as unhandledRejection. The await below observes the result.
        promise.catch(() => {
            /* swallowed — start() owns the awaitInitialization promise */
        });
        try {
            await this.sidecar.send(fallback, req as unknown as object);
        } catch {
            // Transport-level failure — the dispatcher's timeout (or a later
            // reject) will resolve the await below; do not crash runInitialize.
        }
        try {
            const result = await promise;
            // Wire protocol check — the response is the authority now that the
            // hello frame is retired. Validate the shape first so a malformed
            // response is distinguishable from a version mismatch in logs.
            const protocol = result.protocolVersion as
                | { major?: unknown; minor?: unknown }
                | undefined;
            if (
                typeof protocol?.major !== "number" ||
                typeof protocol?.minor !== "number" ||
                !isCompatibleSidecarProtocol({ major: protocol.major, minor: protocol.minor })
            ) {
                const sidecarVersion = protocol ? `${protocol.major}.${protocol.minor}` : "none";
                throw new Error(
                    `incompatible sidecar protocol: sidecar advertises ${sidecarVersion}, ` +
                        `client requires major ${SIDECAR_PROTOCOL_VERSION.major} with ` +
                        `minor >= ${SIDECAR_PROTOCOL_VERSION.minor}`,
                );
            }
            // History payloads passthrough pi's jsonl entries, which the wire
            // protocol version does not cover. A sidecar advertising a newer
            // session format than this build understands cannot have its history
            // rendered correctly — fail the handshake instead of corrupting the
            // UI. A missing field means the sidecar predates sessionFormatVersion
            // gating; pre-launch, treat that as a hard mismatch too.
            if (typeof result.sessionFormatVersion !== "number") {
                throw new Error("sidecar initialize response missing sessionFormatVersion");
            }
            if (result.sessionFormatVersion > CURRENT_SESSION_FORMAT_VERSION) {
                throw new Error(
                    `sidecar session format ${result.sessionFormatVersion} is newer than supported ${CURRENT_SESSION_FORMAT_VERSION}`,
                );
            }
            if (typeof result.instanceId === "string") {
                this.currentInstanceId = result.instanceId;
                // Process-level epoch — instanceId change ⇒ daemon replaced
                // (upgrade swap mid-session); fire per-workspace handlers so
                // the UI resets state owned by the old instance. The handshake
                // itself is already against the new instance, so unlike the
                // old hello-driven path there is nothing to re-negotiate.
                if (this.epochs.observe("*", result.instanceId) === "replaced") {
                    for (const cwd of this.ensuredCwds) {
                        for (const handler of this.epochChangeHandlers) handler(cwd);
                    }
                }
            }
            // A missing instanceId means a pre-P1 sidecar (version skew during
            // a rolling upgrade): epoch tracking stays dormant until the
            // daemon is upgraded. Not fatal — attaches still drive the UI.
            if (this.processInitialization === initialization) {
                this.processInitialized = true;
                initialization.resolve();
                this.processInitialization = undefined;
                this.initializeAttempt = undefined;
            } else {
                this.processInitialized = true;
            }
        } catch (error) {
            // If start() / handleExit / dispose have not already settled the
            // shared promise, settle it here — otherwise the rejection becomes
            // an unhandledRejection (no other consumer awaits it).
            if (this.processInitialization === initialization) {
                initialization.reject(error instanceof Error ? error : new Error(String(error)));
                this.processInitialization = undefined;
                this.initializeAttempt = undefined;
            }
        }
    }

    /** Process death ⇒ all workspace pending RPCs fail + clear start state. */
    private handleExit(exit: SidecarExit): void {
        const reason = new Error(
            `sidecar exited${exit.code === undefined ? "" : ` (code ${exit.code})`}${exit.reason ? `: ${exit.reason}` : ""}`,
        );
        // Reject rather than drop: an in-flight `initialize` has no response
        // coming once the process is gone, so awaitInitialization would sit on
        // its own 10s timeout. runInitialize's catch tolerates the promise
        // already being settled here (it re-checks identity before settling).
        this.processInitialization?.reject(reason);
        this.processInitialization = undefined;
        this.initializeAttempt = undefined;
        this.processInitialized = false;
        this.pendingProcessCwd = undefined;
        // Fan-out: every started workspace's pending RPCs fail. callProcess's
        // pending also hangs under some ensured cwd (callProcess → call(fallback)),
        // already covered by the loop. The final rejectAllPending is defensive
        // (future process-level pending without a workspace); currently a no-op.
        for (const cwd of this.ensuredCwds) {
            this.rejectWorkspacePending(cwd, reason);
        }
        this.rejectAllPending(reason);
        // Daemon death replaces the owner of every started workspace. Fire
        // the epoch handlers here, before the state clear below: the
        // reconnect handshake observes a freshly-cleared epoch table and
        // cannot detect "replaced" on its own. UI hooks (SIDECAR_RESTARTED,
        // compaction-state resets) must not wait for the reconnect.
        for (const cwd of this.ensuredCwds) {
            for (const handler of this.epochChangeHandlers) handler(cwd);
        }
        this.ensuredCwds.clear();
        this.epochs.clearAll();
        // PR4: schedule an upgrade-aware reconnect. We don't reconnect from
        // `dispose()` because that's a deliberate shutdown — the caller
        // owns the lifecycle. `reconnectCwd` stays set so the loop knows
        // which workspace to re-ensure against.
        if (this.reconnectCwd !== undefined && !this.reconnectInFlight) {
            void this.runReconnect(this.reconnectCwd);
        }
    }

    /** PR4: reconnect with backoff + upgrade-marker detection.
     *
     *  Flow per the plan's `ensureDaemon` pseudocode:
     *    1. Wait `backoffMs` (500 → 1s → 2s → 5s).
     *    2. Probe `upgradeMarkerPresent`. If true, run `upgradeApply`
     *       (which atomically swaps staging → live and clears the marker).
     *    3. Re-call `start(cwd)` — same path the user-facing mount flow
     *       uses, so a successful reconnect goes through the same
     *       initialize handshake and emits the same epoch transitions as a
     *       normal mount.
     *    4. On failure, repeat with the next backoff. After the last entry
     *       the loop gives up; the user can retry via the UI's reconnect
     *       control (or a hard refresh) at that point.
     *
     *  Why we don't restart ourselves in Rust: the swap needs to happen
     *  BEFORE the new spawn so the new binary is the one the launcher picks
     *  up. Rust would have to do `upgrade_apply` + `wait_for_daemon_socket`
     *  anyway, so the JS side keeping the loop is a simpler integration
     *  with the existing `start()` flow.
     */
    private async runReconnect(cwd: WorkspaceId): Promise<void> {
        this.reconnectInFlight = true;
        const backoffs = [500, 1000, 2000, 5000] as const;
        try {
            for (const backoffMs of backoffs) {
                await new Promise((resolve) => setTimeout(resolve, backoffMs));
                try {
                    const pending = await this.sidecar.upgradeMarkerPresent();
                    if (pending) {
                        try {
                            await this.sidecar.upgradeApply();
                        } catch {
                            // Best-effort — fall through to re-ensure; the
                            // daemon will start against the old binary.
                        }
                    }
                    await this.start(cwd);
                    return;
                } catch {
                    // Try the next backoff.
                }
            }
        } finally {
            this.reconnectInFlight = false;
        }
    }
}
