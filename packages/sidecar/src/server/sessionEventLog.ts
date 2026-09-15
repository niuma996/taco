import type { ServerPush, SessionId, WorkspaceId } from "@taco-ai/protocol";
import type { DurablePushLog } from "./durablePushLog.ts";

export interface SessionEventReplay {
    events: ServerPush[];
    firstSeq: number;
    lastSeq: number;
    resetRequired: boolean;
}

interface SessionStream {
    nextSeq: number;
    events: ServerPush[];
}

/**
 * Bounded replay log for session push frames. The in-memory ring is the
 * working set; when a `DurablePushLog` is supplied, frames are also buffered
 * to a per-session disk tail and `hydrate` can restore the ring (and seq
 * continuity) after a process restart. See `docs/sidecar-protocol.md`
 * "Session Event Replay".
 */
export class SessionEventLog {
    private readonly streams = new Map<string, SessionStream>();

    constructor(
        private readonly capacity = 512,
        private readonly durable?: DurablePushLog,
    ) {}

    append(
        workspace: WorkspaceId,
        session: SessionId,
        create: (seq: number) => ServerPush,
    ): ServerPush {
        const stream = this.getStream(workspace, session);
        const event = create(stream.nextSeq++);
        stream.events.push(event);
        if (stream.events.length > this.capacity) stream.events.shift();
        // `this` is the append claim token: seqs are numbered per ring, so the
        // tail admits frames from exactly one ring. See DurablePushLog.claim.
        this.durable?.scheduleAppend(event, this);
        return event;
    }

    /**
     * Seed the ring from the disk tail after a process restart.
     *
     * No-op while the stream is live (the in-memory ring is fresher and
     * already continuous). On success the next `append` continues from the
     * tail's last seq + 1 — a client whose cursor predates the restart sees
     * contiguous frames instead of a seq reset it would discard as
     * duplicates. A missing/empty tail leaves state untouched, so the first
     * frame of a brand-new session still starts at seq 1.
     */
    async hydrate(workspace: WorkspaceId, session: SessionId): Promise<void> {
        if (!this.durable) return;
        const key = keyFor(workspace, session);
        const existing = this.streams.get(key);
        if (existing && existing.events.length > 0) return;
        const tail = await this.durable.loadTail(workspace, session, this.capacity, this);
        if (tail.length === 0) return;
        const lastSeq = tail.at(-1)?.seq;
        if (lastSeq === undefined) return;
        this.streams.set(key, { nextSeq: lastSeq + 1, events: tail });
    }

    /**
     * Replay events newer than `afterSeq`.
     *
     * Returns `{ resetRequired: true, events: [] }` when `afterSeq` falls
     * behind the in-memory ring's `firstSeq - 1` — the events the caller
     * asked for are no longer buffered (either capacity eviction or a
     * `session.deleted` tombstone aged out). Callers must reset session
     * state and pull from the returned `firstSeq`; events between
     * `afterSeq` and `firstSeq - 1` are unrecoverable through push replay.
     *
     * This is a process-local best-effort — the on-disk
     * `sessions/<ws>/<sid>.jsonl` remains the canonical history. See the
     * "Session Event Replay" section of `docs/sidecar-protocol.md` for the
     * full contract.
     */
    replay(workspace: WorkspaceId, session: SessionId, afterSeq: number): SessionEventReplay {
        const stream = this.streams.get(keyFor(workspace, session));
        if (!stream || stream.events.length === 0) {
            return { events: [], firstSeq: 1, lastSeq: 0, resetRequired: afterSeq > 0 };
        }
        const firstSeq = stream.events[0]?.seq ?? stream.nextSeq;
        const lastSeq = stream.events.at(-1)?.seq ?? firstSeq - 1;
        if (afterSeq < firstSeq - 1) {
            return { events: [], firstSeq, lastSeq, resetRequired: true };
        }
        return {
            events: stream.events.filter((event) => (event.seq ?? 0) > afterSeq),
            firstSeq,
            lastSeq,
            resetRequired: false,
        };
    }

    lastSeq(workspace: WorkspaceId, session: SessionId): number {
        const stream = this.streams.get(keyFor(workspace, session));
        return stream ? stream.nextSeq - 1 : 0;
    }

    clearSession(workspace: WorkspaceId, session: SessionId): void {
        this.streams.delete(keyFor(workspace, session));
        // The session is gone — its tail is garbage. Process-level `clear()`
        // deliberately keeps disk state: that reset is exactly what hydrate
        // exists to recover from.
        this.durable?.remove(workspace, session);
    }

    /**
     * Drain the disk tail on graceful shutdown, then hand this ring's stream
     * claims back so a reconnecting client can take them over. No-op without a
     * durable log. See `DurablePushLog.flush` for why awaiting the chain is not
     * enough, and `DurablePushLog.claim` for the ownership rule.
     */
    async flushDurable(): Promise<void> {
        if (!this.durable) return;
        await this.durable.flush();
        this.durable.releaseOwner(this);
    }

    clearWorkspace(workspace: WorkspaceId): void {
        const prefix = `${workspace}\u0000`;
        for (const key of this.streams.keys()) {
            if (key.startsWith(prefix)) this.streams.delete(key);
        }
    }

    clear(): void {
        this.streams.clear();
    }

    private getStream(workspace: WorkspaceId, session: SessionId): SessionStream {
        const key = keyFor(workspace, session);
        let stream = this.streams.get(key);
        if (!stream) {
            stream = { nextSeq: 1, events: [] };
            this.streams.set(key, stream);
        }
        return stream;
    }
}

function keyFor(workspace: WorkspaceId, session: SessionId): string {
    return `${workspace}\u0000${session}`;
}
