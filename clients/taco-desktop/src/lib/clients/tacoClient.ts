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
    ErrorCodes,
    isCompatibleSidecarProtocol,
    PushMethods,
    type RpcRequest,
    SIDECAR_PROTOCOL_VERSION,
    type WorkspaceId,
} from "@taco-ai/protocol";
import {
    FAST_RPC_METHODS,
    FAST_RPC_TIMEOUT_MS,
    RPC,
    RpcRemoteError,
    TacoClientBase,
} from "@taco-ai/shared";
import { type EpochTransition, SessionEpochs } from "../sessionEpoch";
import {
    defaultSidecarClient,
    type SidecarClient,
    type SidecarExit,
    type SidecarFrame,
} from "../sidecar";
import { SidecarEpochs } from "../sidecarEpoch";

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

/**
 * One in-flight or settled handshake. Every concurrent `start()` caller observes the
 * same settlement — success resolves `processInitialized` and unblocks every awaiter;
 * failure rejects every awaiter (no timeout past the initial handshake). Late responses
 * from a previous generation (daemon replacement / death) are dropped: they'd otherwise
 * set `processInitialized` against a stale connection and lock out reconnect — the bug
 * that produced 30-60s stalls on every cold start.
 */
interface Handshake extends Readiness {
    /** Monotonic id — bumped on every new handshake. */
    generation: number;
}

/**
 * Singleton sentinel returned by `createHandshake` when the process is
 * already initialized. Its promise is pre-resolved so `awaitHandshake`
 * exits in microseconds without touching the timeout. Generation is `0`
 * so it never matches a real handshake (preventing accidental merging).
 */
const ALREADY_INITIALIZED: Handshake = (() => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
        resolve = r;
    });
    promise.catch(() => {});
    resolve();
    return { generation: 0, promise, resolve, reject: () => {} };
})();

// The 20 typed methods are injected at construction by the base class's
// createTypedRpc via Object.assign; the TS type is visible through interface
// merging. See TacoClientBase for details.
//
// TODO(remove-suppression): drop this declaration-merging pattern once
// TacoClient declares its methods directly. The current Object.assign
// indirection exists to avoid re-implementing each typed RPC method on
// every concrete client — revisit when the RPC surface stabilizes or
// when a future codegen step produces the per-method shims.
export interface TacoClient extends TacoClientBase {}

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: see interface comment above; suppress until TacoClient declares methods directly (see TODO above).
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
    /** True when the caller passed `rpcTimeoutMs` explicitly. Suppresses the
     *  FAST_RPC_METHODS tier so an explicit bound is honoured verbatim — tests
     *  set small values and expect them to apply to every method. */
    private readonly rpcTimeoutMsExplicit: boolean;
    /**
     * Workspaces owned by a daemon that has since exited. Snapshotted in
     * handleExit (before ensuredCwds is cleared) and consumed by the next
     * successful initialize handshake's replaced-sweep, so epoch handlers
     * fire exactly once per daemon replacement — at the moment the new
     * daemon is confirmed serving, not when the old one dies.
     */
    private replacedCwds = new Set<WorkspaceId>();
    /**
     * Process-level handshake state. `processInitialized` flips true after a successful
     * `initialize` response; `handshake` is the single in-flight or settled handshake
     * promise every concurrent `start()` caller awaits. The previous design kept
     * `processInitialization` (a single promise) but its success path could mark
     * `processInitialized=true` without resolving the awaiters — late responses from a
     * dead daemon poisoned reconnect, so every cold start paid 10s × N timeout cascades.
     * The new monotonic handshake checks `generation` and drops mismatches.
     */
    private handshake: Handshake | null = null;
    private handshakeGeneration = 0;
    private processInitialized = false;
    /** The handshake whose `initialize` request is currently in flight.
     *  Guards against duplicate `initialize` requests when runInitialize
     *  is called concurrently (start() + call()-driven ensureInitialized). */
    private initializeAttempt: Handshake | undefined;
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
        this.rpcTimeoutMsExplicit = opts.rpcTimeoutMs !== undefined;
        this.rpcTimeoutMs = opts.rpcTimeoutMs ?? 1_000_000;
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
    async start(cwd: WorkspaceId): Promise<void> {
        await this.ensureListeners();
        if (this.ensuredCwds.has(cwd)) return;
        // Set the handshake fallback channel BEFORE awaiting ensureWorkspace —
        // runInitialize runs concurrently with other start() callers and reads
        // this field to find a transport channel.
        this.pendingProcessCwd = cwd;
        // PR4: remember the cwd so a sidecar-exited event can reconnect.
        this.reconnectCwd = cwd;
        const handshake = this.createHandshake();
        try {
            await this.sidecar.ensureWorkspace(cwd);
            // Drive the handshake (fire-and-forget). awaitHandshake below is
            // the actual readiness barrier — every concurrent start() awaits
            // the same handshake so the response settles them all at once.
            if (!this.processInitialized && this.handshake === handshake) {
                void this.runInitialize();
            }
            await this.awaitHandshake(handshake);
            this.ensuredCwds.add(cwd);
            this.pendingProcessCwd = undefined;
        } catch (error) {
            // Settle the handshake so concurrent start() callers fail fast
            // instead of waiting on the dispatcher's 1000s timeout. Only the
            // still-current handshake can be settled — a newer one is the
            // reconnect's responsibility.
            if (this.handshake === handshake) {
                this.handshake = null;
                this.initializeAttempt = undefined;
                handshake.reject(error instanceof Error ? error : new Error(String(error)));
            }
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
        // timeout. The no-op catch on the handshake promise keeps the
        // rejection from surfacing as an unhandledRejection.
        if (this.handshake) {
            this.handshake.reject(new Error("client disposed"));
            this.handshake = null;
        }
        this.initializeAttempt = undefined;
        this.processInitialized = false;
        this.pendingProcessCwd = undefined;
        this.ensuredCwds.clear();
        this.replacedCwds.clear();
        this.epochs.clearAll();
        // disposeAll SIGTERMs on the Rust side, with SIGKILL after 1s as fallback.
        await this.sidecar.disposeAll();
    }

    /** Fires before pushes from a replacement sidecar instance enter the dispatcher. */
    onWorkspaceEpochChanged(handler: (workspace: WorkspaceId) => void): () => void {
        this.epochChangeHandlers.add(handler);
        return () => this.epochChangeHandlers.delete(handler);
    }

    /** Pull — registers pending via the dispatcher and sends the frame.
     *
     * Self-healing on the slot-replacement race: if the Rust slot is replaced between the
     * handshake completing and this call's frame landing on the wire, the daemon
     * (per-connection `isInitialized=false` for the new connection) returns `not_initialized`.
     * The old code let that rejection escape as an Unhandled Promise Rejection (notably in
     * `attachSession`'s unguarded `sessionHistory` call). The new code treats `not_initialized`
     * as a transient: it awaits the in-flight reconnect handshake and retries the call
     * exactly once. After that, the call either succeeds or surfaces a real error.
     */
    async call<TParams = unknown, TResult = unknown>(
        workspace: WorkspaceId,
        method: string,
        params: TParams,
    ): Promise<TResult> {
        // Skip the gate for `initialize` itself — runInitialize sends it
        // via this.sidecar.send directly to avoid a circular wait.
        // Awaited (not fire-and-forget) so a follow-up RPC fired in the same
        // tick doesn't reach the daemon before its initialize handler has
        // run — the cold-start race that caused 15s session.list timeouts
        // when initialize + session.list arrived in one socket batch.
        if (method !== RPC.initialize) {
            await this.ensureInitialized(workspace);
        }
        try {
            return await this.sendOnce<TParams, TResult>(workspace, method, params);
        } catch (err) {
            if (
                err instanceof RpcRemoteError &&
                err.code === ErrorCodes.NotInitialized &&
                method !== RPC.initialize
            ) {
                // Slot-replacement race window: the frame landed on the new
                // connection before its handshake finished. Wait for that
                // handshake (handleExit's runReconnect drove it; if not yet
                // scheduled, fall back to triggering one ourselves) and retry.
                await this.ensureInitialized(workspace);
                if (this.handshake) {
                    try {
                        await this.awaitHandshake(this.handshake);
                    } catch {
                        // Handshake failed; the retry will surface the error.
                    }
                }
                return await this.sendOnce<TParams, TResult>(workspace, method, params);
            }
            throw err;
        }
    }

    /** One-shot send — registers pending, sends the frame, awaits the response. */
    private async sendOnce<TParams, TResult>(
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
        // Tiered ceiling. Pure reads (FAST_RPC_METHODS) get seconds; anything
        // model-bound or mutating keeps the long default. Without the split, a
        // daemon that completes the handshake and then stops answering parks
        // every metadata read for rpcTimeoutMs (default ~16.7min) with no error
        // to catch — the cold-start path awaits session.list, so the sidebar
        // stays empty for as long as the daemon stays wedged.
        //
        // An explicit `rpcTimeoutMs` option always wins: tests pass small
        // values expecting them to apply uniformly, and a caller that asks for
        // a tighter bound should not be silently given a looser one.
        const effectiveTimeoutMs =
            this.rpcTimeoutMsExplicit || !FAST_RPC_METHODS.has(method)
                ? this.rpcTimeoutMs
                : Math.min(FAST_RPC_TIMEOUT_MS, this.rpcTimeoutMs);
        const timeout = setTimeout(() => {
            this.dispatcher.rejectPending(
                id,
                new Error(`RPC timeout after ${effectiveTimeoutMs}ms: ${method}`),
            );
        }, effectiveTimeoutMs);
        try {
            // The Tauri IPC layer has its own backpressure (mpsc::channel(64) +
            // tokio writer task on the Rust side). A wedged socket means
            // sidecar.send hangs forever even though our own timer rejects the
            // pending promise — without a matching bound here the microtask
            // stays parked forever, and every subsequent RPC that goes
            // through the same path queues behind it. Bound the send to the
            // same ceiling: once the timer fires we know the round-trip
            // can't possibly complete, so the send itself is doomed.
            const sendRace = this.sidecar.send(workspace, req as unknown as object);
            const sendResult = await Promise.race([
                sendRace.then(() => "__ok__" as const).catch((e) => ({ err: String(e) })),
                new Promise<"__timeout__">((resolve) =>
                    setTimeout(() => resolve("__timeout__"), effectiveTimeoutMs),
                ),
            ]);
            if (sendResult === "__timeout__") {
                // Best-effort cleanup — the IPC call may still resolve later
                // but we no longer care. We can't cancel a Tauri invoke from
                // JS, so just let it complete in the background.
                sendRace.catch(() => {});
            } else if (typeof sendResult === "object" && "err" in sendResult) {
                // Sidecar.send itself rejected — propagate to the pending
                // promise so the caller sees the real transport failure
                // instead of waiting on the RPC timeout.
                this.dispatcher.rejectPending(id, new Error((sendResult as { err: string }).err));
            }
        } catch (error) {
            this.dispatcher.rejectPending(
                id,
                error instanceof Error ? error : new Error(String(error)),
            );
        }
        return (await promise.finally(() => clearTimeout(timeout))) as TResult;
    }

    /**
     * Block until the process handshake has completed (success or failure). Called by
     * `call()` only — `runInitialize` sends the handshake frame itself. Happy path is
     * `processInitialized === true` (no await). A mid-handshake call awaits the in-flight
     * handshake; a call after a daemon death that hasn't yet triggered `handleExit`'s
     * reconnect triggers one itself, so `call()` is self-healing on the slot-replacement
     * race window.
     *
     * IMPORTANT: the `processInitialized` fast path must NOT `await` — even
     * `await Promise.resolve()` introduces a microtask boundary that lets synchronous
     * `emitExit()` race ahead of `sendOnce`'s pending registration, leaving the RPC
     * stranded until its 50ms timer fires. The "desktop client waits for initialize" test
     * exercises this race. Keep the check synchronous.
     */
    /**
     * Trigger the initialize handshake and await its settlement. Synchronous on the happy
     * path; on the cold-start path it kicks runInitialize (fire-and-forget for the init
     * frame) and waits for the handshake promise so the caller only resumes after the
     * daemon has answered initialize. The await closes the cold-start race where a
     * follow-up RPC in the same tick reaches the daemon with workspaceMap unbuilt.
     *
     * Returns once the handshake resolves (or rejects). The caller — `call()` — catches
     * the rejection if the RPC should fail fast; the common shape is "let the send retry
     * on not_initialized" so this method swallows await failures.
     */
    private async ensureInitialized(workspace: WorkspaceId): Promise<void> {
        if (this.processInitialized) return;
        if (!this.handshake) {
            this.pendingProcessCwd = workspace;
            void this.runInitialize();
        }
        // Read after the runInitialize kick above so we capture whichever
        // handshake the kick attached. If the kick didn't create one (e.g.
        // another concurrent caller already did and is awaiting the same one),
        // this field is set; the only path that leaves it null is the
        // synchronous check on line 1 above which already returned.
        const handshake = this.handshake;
        if (!handshake) return;
        try {
            await this.awaitHandshake(handshake);
        } catch {
            // Handshake failed; the call() retry path will surface the error
            // on its next attempt. Don't propagate here — call() must always
            // proceed to sendOnce so the retry has a chance to either land on
            // a now-initialized connection or hit not_initialized and retry.
        }
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
     * Return the current handshake — a singleton resolved handshake if the
     * process is already initialized, the in-flight handshake if one exists,
     * or a freshly created one otherwise. Concurrent start() callers all
     * receive the same reference and observe the same settlement.
     */
    private createHandshake(): Handshake {
        if (this.processInitialized) return ALREADY_INITIALIZED;
        if (this.handshake) return this.handshake;
        return this.newHandshake();
    }

    private newHandshake(): Handshake {
        let resolve!: () => void;
        let reject!: (reason: Error) => void;
        const promise = new Promise<void>((r, j) => {
            resolve = r;
            reject = j;
        });
        // Several paths reject this promise (handleExit, runInitialize,
        // dispose, start's catch) and any of them can fire when no
        // start() is awaiting — e.g. a process death after start() resolved.
        // A no-op catch keeps those rejections from surfacing as
        // unhandledRejection; real awaiters observe the error.
        promise.catch(() => {});
        const handshake: Handshake = {
            generation: ++this.handshakeGeneration,
            promise,
            resolve,
            reject,
        };
        this.handshake = handshake;
        return handshake;
    }

    private async awaitHandshake(handshake: Handshake): Promise<void> {
        // The ALREADY_INITIALIZED sentinel resolves immediately, so post-init
        // starts exit in microseconds. Real handshakes wait on the response
        // or on the 10s safety net (kept as a backstop in case the daemon
        // is alive but never answers — surface a clear error rather than
        // hanging the UI forever).
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                handshake.promise,
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
     * Parse a push frame for session-lifecycle events and update the SessionEpochs tracker.
     * Called from the onPush listener, so the parse cost is paid once per frame.
     *
     * Events we care about:
     *   - session.attached → observe (workspace, sessionId, currentInstanceId)
     *   - session.detached → forget (session no longer live on this daemon)
     *   - session.deleted  → forget (same as detached)
     * All other push methods are ignored: tool_call_start, session.event, etc. carry
     * sessionId but their lifecycle is owned by SessionCursor / the reducer. SessionEpochs
     * only cares about "is this session still attached on this daemon instance?"
     */
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
     * Send a single `initialize` request for the current sidecar process. On success, flip
     * `processInitialized` and resolve the in-flight handshake. On failure (incompatible
     * protocol / timeout / transport send failure), reject the handshake so concurrent
     * `start(cwd)` callers fail too — and crucially, the send-failure path settles the
     * handshake immediately rather than waiting for the dispatcher's 1000s timeout (which
     * is what made the previous design burn 10s per stall).
     *
     * The late-response guard (generation mismatch) is the actual fix for the 30-60s
     * cold-start stall: a response from the dead daemon's connection that arrives after
     * `handleExit` started a new handshake must NOT mutate `processInitialized`, or
     * reconnect's runInitialize would early-return on the stale flag and leave the new
     * handshake unresolvable.
     */
    private async runInitialize(): Promise<void> {
        // If the handshake already succeeded for this process, there is no
        // work to do — even if a new workspace's start() called us. The
        // epoch replacement path resets `processInitialized` to false
        // explicitly, so a reconnect still re-handshakes.
        if (this.processInitialized) return;
        const handshake = this.createHandshake();
        // Concurrent runInitialize callers (start() + call()-driven
        // ensureInitialized) can all reach this point before the response
        // lands; the in-flight guard lets only one actually send.
        if (this.initializeAttempt === handshake) return;
        const fallback = this.pendingProcessCwd ?? this.ensuredCwds.values().next().value;
        if (!fallback) {
            // No transport channel yet — start() will surface the failure
            // via its own awaitHandshake timeout / catch.
            return;
        }
        this.initializeAttempt = handshake;
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
            /* swallowed — start() owns the awaitHandshake promise */
        });
        try {
            await this.sidecar.send(fallback, req as unknown as object);
        } catch (sendErr) {
            // Transport-level failure (slot torn down mid-handshake). Settle
            // the handshake NOW so awaiters don't hang on the dispatcher's
            // 1000s timeout. Without this, a connect-cleared-mid-send stalls
            // every concurrent start() for 10s.
            if (this.handshake === handshake) {
                this.handshake = null;
                this.initializeAttempt = undefined;
                handshake.reject(
                    sendErr instanceof Error
                        ? sendErr
                        : new Error("sidecar send failed during initialize"),
                );
            }
            return;
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
                // (restart after death, upgrade swap mid-session). Fire
                // per-workspace handlers for the cwds the dead daemon owned
                // (snapshotted in handleExit; ensuredCwds is still repopulating
                // at this point). Timing matters: this runs only after the new
                // daemon answered initialize, so the UI's follow-up RPCs
                // (re-attach etc.) hit a serving process instead of the void.
                if (this.epochs.observe("*", result.instanceId) === "replaced") {
                    // Match emitSessionEpoch's isolation: a listener throw must
                    // not skip replacedCwds.clear() nor bubble to the outer
                    // catch (which would mark the successful handshake as
                    // failed). Per-listner try/catch — a misbehaving subscriber
                    // only loses its own notification, not the whole sweep or
                    // the rest of the workspace notifications.
                    for (const cwd of this.replacedCwds) {
                        for (const handler of this.epochChangeHandlers) {
                            try {
                                handler(cwd);
                            } catch (err) {
                                console.error("[taco] workspace-epoch handler threw", err);
                            }
                        }
                    }
                    this.replacedCwds.clear();
                }
            }
            // A missing instanceId means a pre-P1 sidecar (version skew during
            // a rolling upgrade): epoch tracking stays dormant until the
            // daemon is upgraded. Not fatal — attaches still drive the UI.
            if (this.handshake !== handshake) {
                // Late response from a previous generation. The current
                // handshake (if any) is the reconnect's responsibility; we
                // must not touch `processInitialized`, or the new handshake
                // would early-return on the stale flag and never settle.
                return;
            }
            // Settle exactly once. Concurrent start() awaiters all observe
            // the same resolution.
            this.processInitialized = true;
            this.handshake = null;
            this.initializeAttempt = undefined;
            handshake.resolve();
        } catch (error) {
            // Only settle the handshake if it is still current. A newer
            // generation's handshake is the reconnect's responsibility.
            if (this.handshake === handshake) {
                this.handshake = null;
                this.initializeAttempt = undefined;
                handshake.reject(error instanceof Error ? error : new Error(String(error)));
            }
        }
    }

    /** Process death ⇒ all workspace pending RPCs fail + clear start state. */
    private handleExit(exit: SidecarExit): void {
        const reason = new Error(
            `sidecar exited${exit.code === undefined ? "" : ` (code ${exit.code})`}${exit.reason ? `: ${exit.reason}` : ""}`,
        );
        // Reject rather than drop: an in-flight handshake has no response
        // coming once the process is gone, so awaiters would otherwise sit
        // on the 10s safety net. The new handshake (if any) starts fresh
        // from a cleared state — a late response from the dead daemon
        // arriving after this point is ignored by the generation check.
        if (this.handshake) {
            this.handshake.reject(reason);
            this.handshake = null;
        }
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
        // Daemon death replaces the owner of every started workspace. The
        // epoch table is deliberately NOT cleared: the reconnect handshake's
        // `observe("*", newInstance)` must see the old instanceId to classify
        // as "replaced". Snapshot the started cwds here — `ensuredCwds` is
        // cleared below, but the replaced-sweep in runInitialize still needs
        // to know which workspaces the dead daemon owned.
        this.replacedCwds = new Set(this.ensuredCwds);
        this.ensuredCwds.clear();
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
     * Flow per the plan's `ensureDaemon` pseudocode: (1) wait `backoffMs` (500 → 1s → 2s → 5s);
     * (2) probe `upgradeMarkerPresent`; if true, run `upgradeApply` (atomic staging → live
     * swap, clear marker); (3) re-call `start(cwd)` — same path as mount, so a successful
     * reconnect goes through the same initialize handshake and emits the same epoch
     * transitions; (4) on failure, repeat with the next backoff. After the last entry the
     * loop gives up; the user can retry via the UI's reconnect control (or hard refresh).
     *
     * Why not restart in Rust: the swap must happen BEFORE the new spawn so the launcher
     * picks up the new binary. Rust would do `upgrade_apply` + `wait_for_daemon_socket`
     * anyway, so keeping the loop on the JS side is a simpler integration with `start()`.
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
