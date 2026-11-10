import type { ServerPush, SessionEventsGetResult } from "@taco-ai/protocol";
import { SessionCursor } from "./sessionCursor";
import { SessionQueue } from "./sessionQueue";

export type SnapshotRecovery = { recovered: true; snapshotSeq: number } | { recovered: false };

export interface SessionPushProcessorOptions {
    getEvents: (
        workspace: string,
        session: string,
        afterSeq: number,
    ) => Promise<SessionEventsGetResult>;
    deliver: (push: ServerPush) => void;
    recoverSnapshot: (
        workspace: string,
        session: string,
        sessionKind: "main" | "subagent",
        lastSeq: number,
        targetSeq?: number,
        isCurrent?: () => boolean,
    ) => Promise<SnapshotRecovery>;
    /** Authoritative execution check after replay has caught up. This resolves
     *  reconnect gaps where the run_start happened before the saved cursor, so
     *  replay has no lifecycle frame from which to infer current execution. */
    probeExecution?: (
        workspace: string,
        session: string,
        sessionKind: "main" | "subagent",
    ) => Promise<"idle" | "running" | undefined>;
    onExecutionState?: (workspace: string, session: string, execution: "idle" | "running") => void;
    reportError: (message: string, error?: unknown) => void;
    onSyncState?: (
        workspace: string,
        session: string,
        sync: "recovering" | "current" | "incomplete",
    ) => void;
    /** Backoff delays (ms) between snapshot-recovery attempts; defaults are production values. Tests pass shorter/empty. */
    snapshotRetryDelaysMs?: readonly number[];
}

/** Serially applies sequenced session pushes, replaying or rebuilding on discontinuities. */
export class SessionPushProcessor {
    private readonly cursor = new SessionCursor();
    private readonly queue = new SessionQueue();
    private readonly incompleteStreams = new Set<string>();

    // Throttle window for `recoverGap` / `resync` failures: at most one
    // banner per (workspace, session, kind) per `REPORT_THROTTLE_MS`.
    // The pushed failures still drive the next recovery attempt via the
    // outer `process` loop — only the user-visible error is suppressed.
    private static readonly REPORT_THROTTLE_MS = 5000;
    private readonly lastReportByKey = new Map<string, number>();

    constructor(private readonly options: SessionPushProcessorOptions) {}

    async process(push: ServerPush): Promise<void> {
        if (!push.session) {
            this.options.deliver(push);
            return;
        }
        const session = push.session;
        await this.queue.run(push.workspace, session, async (isCurrent) => {
            const seq = push.seq;
            if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq <= 0) {
                this.options.reportError(
                    `dropping unsequenced session push: ${push.method} (${push.workspace}/${push.session})`,
                );
                await this.resync(push.workspace, session, push.sessionKind ?? "main", isCurrent);
                return;
            }
            const afterSeq = this.cursor.last(push.workspace, session);
            if (seq <= afterSeq) return;
            if (
                seq > afterSeq + 1 ||
                this.incompleteStreams.has(`${push.workspace}\u0000${session}`)
            ) {
                await this.resync(push.workspace, session, push.sessionKind ?? "main", isCurrent);
            }
            if (isCurrent() && seq === this.cursor.last(push.workspace, session) + 1)
                this.applyReplay(push);
        });
    }

    /** Reconcile even when the reconnected daemon sends no new push. */
    async reconcile(
        workspace: string,
        session: string,
        sessionKind: "main" | "subagent" = "main",
    ): Promise<void> {
        await this.queue.run(workspace, session, (isCurrent) =>
            this.resync(workspace, session, sessionKind, isCurrent),
        );
    }

    /** Explicit navigation shares the live/replay queue and snapshot watermark. */
    async refresh(
        workspace: string,
        session: string,
        sessionKind: "main" | "subagent" = "main",
    ): Promise<boolean> {
        return (
            (await this.queue.run(workspace, session, async (isCurrent) => {
                this.options.onSyncState?.(workspace, session, "recovering");
                const afterSeq = this.cursor.last(workspace, session);
                const snapshot = await this.recoverSnapshot(
                    workspace,
                    session,
                    sessionKind,
                    afterSeq,
                    afterSeq,
                    isCurrent,
                );
                if (!isCurrent() || !snapshot.recovered) {
                    if (isCurrent()) {
                        this.incompleteStreams.add(`${workspace}\u0000${session}`);
                        this.options.onSyncState?.(workspace, session, "incomplete");
                    }
                    return false;
                }
                this.cursor.resetTo(workspace, session, snapshot.snapshotSeq);
                await this.resync(workspace, session, sessionKind, isCurrent);
                return isCurrent() && !this.incompleteStreams.has(`${workspace}\u0000${session}`);
            })) ?? false
        );
    }

    /** Same-instance reconnects preserve watermarks but reject all old continuations. */
    invalidate(): void {
        this.queue.invalidate();
    }

    last(workspace: string, session: string): number {
        return this.cursor.last(workspace, session);
    }

    clear(): void {
        this.queue.invalidate();
        this.cursor.clear();
        this.lastReportByKey.clear();
        this.incompleteStreams.clear();
    }

    resetWorkspace(workspace: string): void {
        this.queue.invalidate(workspace);
        this.cursor.resetWorkspace(workspace);
        for (const key of this.incompleteStreams)
            if (key.startsWith(`${workspace}\u0000`)) this.incompleteStreams.delete(key);
    }

    /** Returns true if a (workspace, session, kind) error should surface
     *  to the user; gates repeat reports behind the throttle window.
     *  `afterSeq === 0` is the "baseline miss" case — the cursor never
     *  saw this stream, expected during sidecar startup / StrictMode
     *  remount / restartSidecar windows. Tauri IPC rejects with
     *  "sidecar not started" until the new sidecar is ready, so the
     *  next push re-runs recovery without surfacing anything. */
    private shouldReport(key: string, afterSeq: number): boolean {
        if (afterSeq === 0) return false;
        const now = Date.now();
        const last = this.lastReportByKey.get(key) ?? 0;
        this.lastReportByKey.set(key, now);
        return now - last >= SessionPushProcessor.REPORT_THROTTLE_MS;
    }

    private async resync(
        workspace: string,
        session: string,
        sessionKind: "main" | "subagent",
        isCurrent: () => boolean,
    ): Promise<void> {
        this.options.onSyncState?.(workspace, session, "recovering");
        let sync: "current" | "incomplete" = "incomplete";
        try {
            // One snapshot installation and one follow-up replay per attempt.
            // An unchanged retention response must not spin indefinitely.
            for (let attempt = 0; attempt < 2 && isCurrent(); attempt++) {
                const afterSeq = this.cursor.last(workspace, session);
                let replay: SessionEventsGetResult;
                try {
                    replay = await this.options.getEvents(workspace, session, afterSeq);
                } catch (error) {
                    if (
                        isCurrent() &&
                        this.shouldReport(`${workspace}/${session}/resync`, afterSeq)
                    ) {
                        this.options.reportError(
                            `session event replay failed (${workspace}/${session} after ${afterSeq})`,
                            error,
                        );
                    }
                    return;
                }
                if (!isCurrent()) return;
                if (replay.resetRequired || replay.lastSeq < afterSeq) {
                    if (attempt > 0) return;
                    const recovery = await this.recoverSnapshot(
                        workspace,
                        session,
                        sessionKind,
                        afterSeq,
                        replay.lastSeq,
                        isCurrent,
                    );
                    if (!isCurrent() || !recovery.recovered) return;
                    this.cursor.resetTo(workspace, session, recovery.snapshotSeq);
                    continue;
                }
                for (const event of [...replay.events].sort(
                    (a, b) => (a.seq ?? 0) - (b.seq ?? 0),
                )) {
                    if (!isCurrent()) return;
                    if (event.workspace !== workspace || event.session !== session) {
                        this.options.reportError(
                            "sidecar returned a replay frame for a different session",
                        );
                        continue;
                    }
                    this.applyReplay(event);
                }
                if (this.cursor.last(workspace, session) === replay.lastSeq) {
                    try {
                        const execution = await this.options.probeExecution?.(
                            workspace,
                            session,
                            sessionKind,
                        );
                        if (execution && isCurrent()) {
                            this.options.onExecutionState?.(workspace, session, execution);
                        }
                    } catch (error) {
                        if (isCurrent()) {
                            this.options.reportError(
                                `session execution probe failed (${workspace}/${session})`,
                                error,
                            );
                        }
                    }
                    sync = "current";
                }
                return;
            }
        } finally {
            if (isCurrent()) {
                const key = `${workspace}\u0000${session}`;
                if (sync === "current") this.incompleteStreams.delete(key);
                else this.incompleteStreams.add(key);
                this.options.onSyncState?.(workspace, session, sync);
            }
        }
    }

    private applyReplay(push: ServerPush): void {
        const seq = push.seq;
        if (!push.session || typeof seq !== "number" || !Number.isSafeInteger(seq) || seq <= 0) {
            this.options.reportError("sidecar returned an invalid replay frame");
            return;
        }
        const previous = this.cursor.last(push.workspace, push.session);
        const decision = this.cursor.observe(push.workspace, push.session, seq);
        if (decision === "accepted") {
            try {
                this.options.deliver(push);
            } catch (error) {
                this.cursor.resetTo(push.workspace, push.session, previous);
                throw error;
            }
            return;
        }
        if (decision !== "duplicate") {
            this.options.reportError(
                `sidecar returned a non-contiguous replay frame (${push.workspace}/${push.session} seq ${push.seq})`,
            );
        }
    }

    private static readonly SNAPSHOT_RETRY_DELAYS_MS = [500, 1500, 4000];

    private get retryDelays(): readonly number[] {
        return this.options.snapshotRetryDelaysMs ?? SessionPushProcessor.SNAPSHOT_RETRY_DELAYS_MS;
    }

    private async recoverSnapshot(
        workspace: string,
        session: string,
        sessionKind: "main" | "subagent",
        afterSeq: number,
        lastSeq: number,
        isCurrent: () => boolean,
    ): Promise<SnapshotRecovery> {
        // A failed snapshot (e.g. `snapshot_unstable` while a turn is mid-flight)
        // leaves the cursor where it was, so the next push re-runs the same
        // recovery. Retry with backoff here so a busy session converges within
        // this call instead of depending on another frame arriving.
        const delays = this.retryDelays;
        // Only a thrown error carries a real cause. A `recovered: false` return
        // means the option already reported the reason itself (the desktop
        // integration logs + banners it), so we must not invent one here.
        let lastError: unknown;
        for (let attempt = 0; attempt <= delays.length && isCurrent(); attempt++) {
            try {
                const recovery = await this.options.recoverSnapshot(
                    workspace,
                    session,
                    sessionKind,
                    afterSeq,
                    lastSeq,
                    isCurrent,
                );
                if (!isCurrent()) return { recovered: false };
                if (recovery.recovered) return recovery;
                lastError = undefined;
            } catch (error) {
                lastError = error;
            }
            if (!isCurrent()) return { recovered: false };
            const delay = delays[attempt];
            if (delay !== undefined) {
                await new Promise((resolve) => setTimeout(resolve, delay));
            }
        }
        // Throttled like the gap/resync paths: a permanently broken session
        // (e.g. the sidecar dropped it) would otherwise report on every frame.
        if (isCurrent() && this.shouldReport(`${workspace}/${session}/snapshot`, afterSeq)) {
            this.options.reportError(
                `session snapshot recovery failed (${workspace}/${session})`,
                lastError,
            );
        }
        return { recovered: false };
    }
}
