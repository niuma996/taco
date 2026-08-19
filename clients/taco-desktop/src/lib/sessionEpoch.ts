/** Per-session sidecar process identity tracking.
 *
 *  Mirrors `SidecarEpochs` at session granularity. A session that was
 *  attached to one daemon process and is then seen on a different instance
 *  is "replaced" — the UI should clear stale state and re-attach.
 *
 *  Why session granularity matters on top of the existing process-level
 *  epoch: the desktop's reconnect loop (`runReconnect`) reattaches the
 *  workspace after a daemon restart, but until re-attach completes the
 *  UI's reducer state can show a session that has no live counterpart on
 *  the daemon (cursor gap detection eventually surfaces this, but only
 *  when the new session's first push arrives). A session-level epoch
 *  gives the UI an immediate, explicit signal: every session seen on
 *  the old daemon process is gone, even if no new push has arrived yet.
 *
 *  Key encoding uses `\u0000` as the workspace/sessionId separator so
 *  workspace names containing `:` or `/` don't collide. Session ids
 *  are app-generated UUIDs by convention (`session.create` and friends)
 *  so this separator is safe in practice. */
export class SessionEpochs {
    private readonly instanceIdBySession = new Map<string, string>();

    /** Record (or refresh) the instanceId for a (workspace, sessionId).
     *  Returns:
     *    - "new":       first time we've seen this session (or it was forgotten).
     *    - "unchanged": same instanceId as before — same daemon still owns the session.
     *    - "replaced":  different instanceId — the session is now on a new daemon. */
    observe(workspace: string, sessionId: string, instanceId: string): EpochTransition {
        const key = encodeKey(workspace, sessionId);
        const previous = this.instanceIdBySession.get(key);
        this.instanceIdBySession.set(key, instanceId);
        if (!previous) return "new";
        return previous === instanceId ? "unchanged" : "replaced";
    }

    /** Iterate every tracked (workspace, sessionId) and its instanceId.
     *  Used by `tacoClientTauri.ts` on daemon restart to emit synthetic
     *  "replaced" transitions for every session that was alive on the
     *  old daemon. Yields tuples to keep the call-site trivial. */
    *entries(): IterableIterator<SessionEpochEntry> {
        for (const [key, instanceId] of this.instanceIdBySession) {
            const sep = key.indexOf("\u0000");
            if (sep === -1) continue;
            const workspace = key.slice(0, sep);
            const sessionId = key.slice(sep + 1);
            yield { workspace, sessionId, instanceId };
        }
    }

    /** Drop a specific session (e.g. when `session.deleted` arrives). */
    forget(workspace: string, sessionId: string): void {
        this.instanceIdBySession.delete(encodeKey(workspace, sessionId));
    }

    /** Drop every session associated with a workspace. Used when the
     *  desktop tears down a workspace without restarting the daemon. */
    clearWorkspace(workspace: string): void {
        const prefix = `${workspace}\u0000`;
        for (const key of this.instanceIdBySession.keys()) {
            if (key.startsWith(prefix)) this.instanceIdBySession.delete(key);
        }
    }

    clearAll(): void {
        this.instanceIdBySession.clear();
    }
}

export type EpochTransition = "new" | "unchanged" | "replaced";

export interface SessionEpochEntry {
    workspace: string;
    sessionId: string;
    instanceId: string;
}

function encodeKey(workspace: string, sessionId: string): string {
    return `${workspace}\u0000${sessionId}`;
}
