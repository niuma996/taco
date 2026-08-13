import type { ServerPush, SessionId, WorkspaceId } from "@taco-ai/protocol";

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

/** Bounded, in-memory replay log for one sidecar process. */
export class SessionEventLog {
    private readonly streams = new Map<string, SessionStream>();

    constructor(private readonly capacity = 512) {}

    append(
        workspace: WorkspaceId,
        session: SessionId,
        create: (seq: number) => ServerPush,
    ): ServerPush {
        const stream = this.getStream(workspace, session);
        const event = create(stream.nextSeq++);
        stream.events.push(event);
        if (stream.events.length > this.capacity) stream.events.shift();
        return event;
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
