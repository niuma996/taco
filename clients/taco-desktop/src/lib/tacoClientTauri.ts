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
    type SidecarHelloParams,
    type WorkspaceId,
} from "@taco-ai/protocol";
import { RPC, TacoClientBase } from "@taco-ai/shared";
import {
    defaultSidecarClient,
    type SidecarClient,
    type SidecarExit,
    type SidecarFrame,
    type SidecarSpawnOptions,
} from "./sidecar";
import { SidecarEpochs } from "./sidecarEpoch";

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
     * Process-level readiness — a shared sidecar sends **one** hello on start(),
     * so readiness is per-process, not per-cwd. All concurrent start(cwd) calls
     * share the same promise. `processReady` lets workspaces opened after hello
     * resolve immediately instead of waiting 10s.
     */
    private processReadiness?: Readiness;
    private processReady = false;
    /**
     * Tracks whether the sidecar's `initialize` handshake has completed in this
     * process. Reset whenever the underlying sidecar is replaced (`instanceId`
     * change) or exits. Server-side `not_initialized` guard rejects every RPC
     * except `initialize` while this is false, so `start(cwd)` waits for both
     * hello and initialize.
     */
    private processInitialization?: Readiness;
    private processInitialized = false;
    /**
     * Cwd the most recent `ensureWorkspace` returned. Used as a fallback for
     * `callProcess` before the first workspace is fully added to
     * `ensuredCwds`. Necessary so the post-hello `initialize` handshake can
     * send a request through `callProcess` (which rejects when nothing is
     * ensured) without changing the public Tauri contract.
     */
    private pendingProcessCwd: WorkspaceId | undefined;
    /** PR4: cwd the last `start(cwd)` call used. Persists across `sidecar-exited`
     *  events so the reconnect loop knows which workspace to re-ensure.
     *  Distinct from `pendingProcessCwd` (cleared on exit) and from
     *  `ensuredCwds` (cleared on exit so a fresh handshake can run). */
    private reconnectCwd: WorkspaceId | undefined;
    /** PR4: set while a reconnect is in flight so a second `sidecar-exited`
     *  event during the same disconnect storm doesn't schedule a parallel
     *  reconnect (which would race on `processReadiness`). */
    private reconnectInFlight = false;
    private readonly epochs = new SidecarEpochs();
    private readonly epochChangeHandlers = new Set<(workspace: WorkspaceId) => void>();

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
        // Set the callProcess fallback BEFORE awaiting ensureWorkspace. The
        // fake's `queueMicrotask(emitHello)` schedules before ensureWorkspace
        // returns, and the post-hello `runInitialize` calls callProcess before
        // we ever reach the `pendingProcessCwd = cwd` line below otherwise.
        this.pendingProcessCwd = cwd;
        // PR4: remember the cwd so a sidecar-exited event can reconnect.
        this.reconnectCwd = cwd;
        const readiness = this.createProcessReadiness();
        const initialization = this.createProcessInitialization();
        try {
            const handshake = await this.sidecar.ensureWorkspace(cwd, options);
            // A client that attached to an already-running sidecar has missed the
            // one-shot hello, and Tauri events have no replay — without this the
            // wait below can only ever time out. Replaying the line the transport
            // handed back covers it; a non-hello line is ignored by observeHello
            // and we fall through to the normal wait.
            if (handshake !== null) this.observeHello({ line: handshake });
            await this.awaitReadiness(readiness);
            // `runInitialize` normally fires from observeHello, but a live
            // sidecar only ever sends one hello. If a previous handshake failed
            // (or this is a second workspace on an un-negotiated process) no
            // further hello is coming, so drive it here. Both paths funnel
            // through the shared promise, so this never double-sends.
            if (!this.processInitialized) void this.runInitialize();
            await this.awaitInitialization(initialization);
            this.ensuredCwds.add(cwd);
            this.pendingProcessCwd = undefined;
        } catch (error) {
            // Concurrent starts share one promise: the first timeout/failure must
            // reject it, otherwise other waiters dangle — if hello arrives late,
            // observeHello can't resolve (processReadiness cleared), and other
            // starts wait their full 10s. initFromStorage's Promise.all hits this.
            this.processReadiness?.reject(
                error instanceof Error ? error : new Error(String(error)),
            );
            this.processReadiness = undefined;
            // Settle explicitly so a concurrent start() awaiting the shared
            // handshake fails now instead of on its own 10s timeout.
            this.processInitialization?.reject(
                error instanceof Error ? error : new Error(String(error)),
            );
            this.processInitialization = undefined;
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
        this.processReadiness?.reject(new Error("client disposed"));
        this.processReadiness = undefined;
        this.processReady = false;
        // Symmetric with handleExit: an in-flight handshake gets no response
        // after dispose, so settle it rather than leaving awaiters on their
        // timeout. createProcessInitialization attaches a no-op catch, so this
        // is safe even when nobody is awaiting.
        this.processInitialization?.reject(new Error("client disposed"));
        this.processInitialization = undefined;
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
                this.observeHello(frame);
                this.buffer.push(`${frame.line}\n`);
            });
        }
        if (!this.unlistenExit) {
            this.unlistenExit = await this.sidecar.onExit((exit) => this.handleExit(exit));
        }
    }

    /**
     * Process-level readiness, create-once. All concurrent start(cwd) share one
     * instance. If hello already arrived (processReady), returns a resolved
     * instance — otherwise workspaces opened later would wait 10s.
     */
    private createProcessReadiness(): Readiness {
        if (this.processReady) {
            return { promise: Promise.resolve(), resolve: () => {}, reject: () => {} };
        }
        if (this.processReadiness) return this.processReadiness;
        let resolve!: () => void;
        let reject!: (reason: Error) => void;
        const promise = new Promise<void>((resolvePromise, rejectPromise) => {
            resolve = resolvePromise;
            reject = rejectPromise;
        });
        this.processReadiness = { promise, resolve, reject };
        return this.processReadiness;
    }

    private async awaitReadiness(readiness: Readiness): Promise<void> {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                readiness.promise,
                new Promise<never>((_, reject) => {
                    timeout = setTimeout(() => reject(new Error("sidecar hello timeout")), 10_000);
                }),
            ]);
        } finally {
            if (timeout) clearTimeout(timeout);
        }
    }

    /**
     * Mirror of `createProcessReadiness` for the `initialize` handshake. Once
     * hello resolves, the start sequence awaits this so the `not_initialized`
     * guard does not reject the first real RPC. Concurrent starts share one
     * promise; failed handshakes (server returning `incompatible_protocol`)
     * reject it so subsequent starts do not silently succeed.
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
        // Several paths reject this promise (handleExit, observeHello's protocol
        // check, runInitialize, dispose) and any of them can fire when no
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
     * Process-level epoch key — hello's `workspace` field is "*" (one per
     * process), so epoch is recorded per-process. instanceId is per-process
     * (randomUUID), used as the restart signal on the client side.
     */
    private observeHello(frame: SidecarFrame): void {
        let parsed: { method?: unknown; params?: unknown };
        try {
            parsed = JSON.parse(frame.line) as { method?: unknown; params?: unknown };
        } catch {
            return;
        }
        if (parsed.method !== PushMethods.Hello) return;
        const hello = parsed.params as Partial<SidecarHelloParams> | undefined;
        if (
            typeof hello?.instanceId !== "string" ||
            !hello.protocol ||
            !isCompatibleSidecarProtocol(hello.protocol)
        ) {
            const sidecarVersion = hello?.protocol
                ? `${hello.protocol.major}.${hello.protocol.minor}`
                : "none";
            const error = new Error(
                `incompatible sidecar protocol: sidecar advertises ${sidecarVersion}, ` +
                    `client requires major ${SIDECAR_PROTOCOL_VERSION.major} with ` +
                    `minor >= ${SIDECAR_PROTOCOL_VERSION.minor}`,
            );
            this.processReadiness?.reject(error);
            this.processReadiness = undefined;
            this.processInitialization?.reject(error);
            this.processInitialization = undefined;
            this.processReady = false;
            this.processInitialized = false;
            // Kill the shared process — it won't resend hello, so keeping it
            // only makes subsequent starts time out. Clear start state for re-spawn.
            this.ensuredCwds.clear();
            this.epochs.clearAll();
            void this.sidecar.disposeAll();
            return;
        }
        const epochTransition = this.epochs.observe("*", hello.instanceId);
        // Process-level epoch — instanceId change ⇒ process replaced, reset all
        // workspaces AND reset the initialize handshake so the replacement
        // sidecar re-negotiates before accepting RPCs.
        if (epochTransition === "replaced") {
            this.processInitialization?.reject(new Error("sidecar instance replaced"));
            this.processInitialization = undefined;
            this.processInitialized = false;
            for (const cwd of this.ensuredCwds) {
                for (const handler of this.epochChangeHandlers) handler(cwd);
            }
        }
        this.processReadiness?.resolve();
        this.processReadiness = undefined;
        this.processReady = true;
        // Kick off the initialize handshake in the background. awaitInitialization
        // waits on the same promise; resolution flips processInitialized so
        // later starts reuse the completed handshake without re-sending.
        void this.runInitialize();
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
        // Send the `initialize` request directly via the dispatcher so this
        // file owns the pending-promise chain end-to-end. Using the typed
        // `client.initialize` wrapper would hand the promise to two consumers
        // (runInitialize's await + typedRpc's internal await) and any
        // dispose-time rejection on the dispatcher could escape as an
        // unhandledRejection. Sending it ourselves lets us attach a catch
        // exactly once before any await.
        const fallback = this.pendingProcessCwd ?? this.ensuredCwds.values().next().value;
        if (!fallback) {
            // No transport channel yet — start() will surface the failure via
            // its own awaitInitialization timeout.
            return;
        }
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
            protocolVersion: typeof SIDECAR_PROTOCOL_VERSION;
            sessionFormatVersion: number;
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
            if (this.processInitialization === initialization) {
                this.processInitialized = true;
                initialization.resolve();
                this.processInitialization = undefined;
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
            }
        }
    }

    /** Process death ⇒ all workspace pending RPCs fail + clear start state. */
    private handleExit(exit: SidecarExit): void {
        const reason = new Error(
            `sidecar exited${exit.code === undefined ? "" : ` (code ${exit.code})`}${exit.reason ? `: ${exit.reason}` : ""}`,
        );
        this.processReadiness?.reject(reason);
        this.processReadiness = undefined;
        // Reject rather than drop: an in-flight `initialize` has no response
        // coming once the process is gone, so awaitInitialization would sit on
        // its own 10s timeout. runInitialize's catch tolerates the promise
        // already being settled here (it re-checks identity before settling).
        this.processInitialization?.reject(reason);
        this.processInitialization = undefined;
        this.processReady = false;
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
     *       uses, so a successful reconnect goes through the same hello +
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
