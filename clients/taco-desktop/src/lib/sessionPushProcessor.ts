import type { ServerPush, SessionEventsGetResult } from "@taco-ai/protocol";
import { SessionCursor } from "./sessionCursor";

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
    ) => Promise<SnapshotRecovery>;
    reportError: (message: string, error?: unknown) => void;
    /** Backoff delays (ms) between snapshot-recovery attempts; defaults are production values. Tests pass shorter/empty. */
    snapshotRetryDelaysMs?: readonly number[];
}

/** Serially applies sequenced session pushes, replaying or rebuilding on discontinuities. */
export class SessionPushProcessor {
    private readonly cursor = new SessionCursor();

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
        const seq = push.seq;
        if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq <= 0) {
            this.options.reportError(
                `dropping unsequenced session push: ${push.method} (${push.workspace}/${push.session})`,
            );
            await this.resync(push.workspace, push.session, push.sessionKind ?? "main");
            return;
        }

        const decision = this.cursor.observe(push.workspace, push.session, seq);
        if (decision === "accepted") {
            this.options.deliver(push);
            return;
        }
        if (decision === "duplicate") return;

        await this.recoverGap(push, decision.afterSeq);
    }

    last(workspace: string, session: string): number {
        return this.cursor.last(workspace, session);
    }

    clear(): void {
        this.cursor.clear();
    }

    resetWorkspace(workspace: string): void {
        this.cursor.resetWorkspace(workspace);
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

    private async recoverGap(target: ServerPush, afterSeq: number): Promise<void> {
        let replay: SessionEventsGetResult;
        try {
            replay = await this.options.getEvents(target.workspace, target.session ?? "", afterSeq);
        } catch (error) {
            if (
                this.shouldReport(`${target.workspace}/${target.session ?? ""}/recover`, afterSeq)
            ) {
                this.options.reportError(
                    `session event replay failed (${target.workspace}/${target.session} after ${afterSeq})`,
                    error,
                );
            }
            return;
        }

        if (replay.resetRequired) {
            const recovery = await this.recoverSnapshot(
                target.workspace,
                target.session ?? "",
                target.sessionKind ?? "main",
                afterSeq,
                replay.lastSeq,
            );
            if (!recovery.recovered) return;
            this.cursor.resetTo(target.workspace, target.session ?? "", recovery.snapshotSeq);
            await this.recoverGap(target, recovery.snapshotSeq);
            return;
        }

        for (const event of [...replay.events].sort(
            (left, right) => (left.seq ?? 0) - (right.seq ?? 0),
        )) {
            await this.applyReplay(event);
        }
        await this.process(target);
    }

    private async resync(
        workspace: string,
        session: string,
        sessionKind: "main" | "subagent",
    ): Promise<void> {
        const afterSeq = this.cursor.last(workspace, session);
        let replay: SessionEventsGetResult;
        try {
            replay = await this.options.getEvents(workspace, session, afterSeq);
        } catch (error) {
            if (this.shouldReport(`${workspace}/${session}/resync`, afterSeq)) {
                this.options.reportError(
                    `session event resync failed (${workspace}/${session} after ${afterSeq})`,
                    error,
                );
            }
            return;
        }
        if (replay.resetRequired) {
            const recovery = await this.recoverSnapshot(
                workspace,
                session,
                sessionKind,
                afterSeq,
                replay.lastSeq,
            );
            if (!recovery.recovered) return;
            this.cursor.resetTo(workspace, session, recovery.snapshotSeq);
            await this.resync(workspace, session, sessionKind);
            return;
        }
        for (const event of [...replay.events].sort(
            (left, right) => (left.seq ?? 0) - (right.seq ?? 0),
        )) {
            await this.applyReplay(event);
        }
    }

    private async applyReplay(push: ServerPush): Promise<void> {
        const seq = push.seq;
        if (!push.session || typeof seq !== "number" || !Number.isSafeInteger(seq) || seq <= 0) {
            this.options.reportError("sidecar returned an invalid replay frame");
            return;
        }
        const decision = this.cursor.observe(push.workspace, push.session, seq);
        if (decision === "accepted") {
            this.options.deliver(push);
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
        for (let attempt = 0; attempt <= delays.length; attempt++) {
            try {
                const recovery = await this.options.recoverSnapshot(
                    workspace,
                    session,
                    sessionKind,
                    afterSeq,
                    lastSeq,
                );
                if (recovery.recovered) return recovery;
                lastError = undefined;
            } catch (error) {
                lastError = error;
            }
            const delay = delays[attempt];
            if (delay !== undefined) {
                await new Promise((resolve) => setTimeout(resolve, delay));
            }
        }
        // Throttled like the gap/resync paths: a permanently broken session
        // (e.g. the sidecar dropped it) would otherwise report on every frame.
        if (this.shouldReport(`${workspace}/${session}/snapshot`, afterSeq)) {
            this.options.reportError(
                `session snapshot recovery failed (${workspace}/${session})`,
                lastError,
            );
        }
        return { recovered: false };
    }
}
