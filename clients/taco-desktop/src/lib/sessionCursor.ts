export type CursorDecision = "accepted" | "duplicate" | { kind: "gap"; afterSeq: number };

/** Tracks the last contiguous server sequence accepted for every session stream. */
export class SessionCursor {
    private readonly lastSeqByStream = new Map<string, number>();

    observe(workspace: string, session: string, seq: number): CursorDecision {
        const current = this.last(workspace, session);
        if (seq <= current) return "duplicate";
        if (seq !== current + 1) return { kind: "gap", afterSeq: current };
        this.lastSeqByStream.set(keyFor(workspace, session), seq);
        return "accepted";
    }

    last(workspace: string, session: string): number {
        return this.lastSeqByStream.get(keyFor(workspace, session)) ?? 0;
    }

    resetTo(workspace: string, session: string, seq = 0): void {
        const key = keyFor(workspace, session);
        if (seq <= 0) this.lastSeqByStream.delete(key);
        else this.lastSeqByStream.set(key, seq);
    }

    resetWorkspace(workspace: string): void {
        const prefix = `${workspace}\u0000`;
        for (const key of this.lastSeqByStream.keys()) {
            if (key.startsWith(prefix)) this.lastSeqByStream.delete(key);
        }
    }

    clear(): void {
        this.lastSeqByStream.clear();
    }
}

function keyFor(workspace: string, session: string): string {
    return `${workspace}\u0000${session}`;
}
