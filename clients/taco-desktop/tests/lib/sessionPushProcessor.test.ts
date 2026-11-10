import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    asSessionId,
    asWorkspaceId,
    type ServerPush,
    type SessionEventsGetResult,
} from "@taco-ai/protocol";
import { getSessionState } from "../../src/lib/chat/sessionState";
import {
    createEmptyWorkspace,
    type WorkspaceState,
    workspacesReducer,
} from "../../src/lib/chat/workspaceReducer";
import { SessionPushProcessor } from "../../src/lib/sessionPushProcessor.ts";

function frame(seq: number): ServerPush {
    return {
        method: "session.event",
        workspace: asWorkspaceId("/workspace"),
        session: asSessionId("session"),
        seq,
        params: { event: { type: "message_start" } },
    };
}

describe("SessionPushProcessor", () => {
    it("replays a detected gap in sequence order and drops the redelivered frame", async () => {
        const delivered: number[] = [];
        const replays: number[] = [];
        const processor = new SessionPushProcessor({
            getEvents: async (_workspace, _session, afterSeq) => {
                replays.push(afterSeq);
                return {
                    events: [frame(2), frame(3)],
                    firstSeq: 1,
                    lastSeq: 3,
                    resetRequired: false,
                } satisfies SessionEventsGetResult;
            },
            deliver: (push) => delivered.push(push.seq ?? 0),
            recoverSnapshot: async () => assert.fail("snapshot should not be needed"),
            reportError: (message) => assert.fail(message),
            // Zero backoff: if a regression ever does reach recoverSnapshot,
            // assert.fail should surface immediately instead of after retries.
            snapshotRetryDelaysMs: [],
        });

        await processor.process(frame(1));
        await processor.process(frame(3));

        assert.deepEqual(replays, [1]);
        assert.deepEqual(delivered, [1, 2, 3]);
        assert.equal(processor.last("/workspace", "session"), 3);
    });

    it("replays from the snapshot watermark when the requested cursor fell out of retention", async () => {
        const delivered: number[] = [];
        const replayAfter: number[] = [];
        const processor = new SessionPushProcessor({
            getEvents: async (_workspace, _session, afterSeq) => {
                replayAfter.push(afterSeq);
                if (afterSeq === 1) {
                    return {
                        events: [],
                        firstSeq: 7,
                        lastSeq: 7,
                        resetRequired: true,
                    };
                }
                return {
                    events: [frame(6)],
                    firstSeq: 1,
                    lastSeq: 7,
                    resetRequired: false,
                };
            },
            deliver: (push) => delivered.push(push.seq ?? 0),
            recoverSnapshot: async () => ({ recovered: true, snapshotSeq: 5 }),
            reportError: (message) => assert.fail(message),
        });

        await processor.process(frame(1));
        await processor.process(frame(7));

        assert.deepEqual(replayAfter, [1, 5]);
        assert.deepEqual(delivered, [1, 6, 7]);
        assert.equal(processor.last("/workspace", "session"), 7);
    });

    it("does not advance the cursor when snapshot recovery fails", async () => {
        const recovered: number[] = [];
        const delivered: number[] = [];
        const processor = new SessionPushProcessor({
            getEvents: async () => ({
                events: [],
                firstSeq: 8,
                lastSeq: 8,
                resetRequired: true,
            }),
            deliver: (push) => delivered.push(push.seq ?? 0),
            recoverSnapshot: async () => {
                recovered.push(1);
                return { recovered: false };
            },
            reportError: () => {},
            snapshotRetryDelaysMs: [],
        });

        await processor.process(frame(1));
        await processor.process(frame(8));
        await processor.process(frame(8));

        assert.equal(processor.last("/workspace", "session"), 1);
        assert.equal(recovered.length, 2);
        assert.deepEqual(delivered, [1]);
    });

    it("keeps the cursor unchanged after repeated snapshot failures", async () => {
        const delivered: number[] = [];
        let snapshotAttempts = 0;
        const processor = new SessionPushProcessor({
            getEvents: async () => ({
                events: [],
                firstSeq: 8,
                lastSeq: 9,
                resetRequired: true,
            }),
            deliver: (push) => delivered.push(push.seq ?? 0),
            recoverSnapshot: async () => {
                snapshotAttempts++;
                return { recovered: false };
            },
            reportError: () => {},
            snapshotRetryDelaysMs: [],
        });

        await processor.process(frame(1));
        await processor.process(frame(10));
        await processor.process(frame(11));
        await processor.process(frame(12));

        assert.equal(snapshotAttempts, 3);
        assert.equal(processor.last("/workspace", "session"), 1);
        assert.deepEqual(delivered, [1]);
    });

    it("does not report a baseline-miss gap (afterSeq === 0) when getEvents fails", async () => {
        const reports: Array<[string, unknown]> = [];
        const processor = new SessionPushProcessor({
            getEvents: async () => {
                throw new Error("sidecar not started");
            },
            deliver: () => {},
            recoverSnapshot: async () => assert.fail("snapshot should not be needed"),
            reportError: (message, error) => reports.push([message, error]),
            snapshotRetryDelaysMs: [],
        });

        // First frame jumps to seq=3 (cursor=0) → gap detected with
        // afterSeq=0. Recovery fails because sidecar is not started.
        // Subsequent frames keep widening the gap; all see afterSeq=0
        // until something is accepted.
        await processor.process(frame(3));
        await processor.process(frame(5));
        await processor.process(frame(7));

        assert.deepEqual(reports, []);
        // Cursor stayed at 0 — none of the failed frames were accepted.
        assert.equal(processor.last("/workspace", "session"), 0);
    });

    it("retries a failed snapshot with the configured backoff before giving up", async () => {
        const delivered: number[] = [];
        const reports: Array<[string, unknown]> = [];
        let attempts = 0;
        const processor = new SessionPushProcessor({
            getEvents: async () => ({ events: [], firstSeq: 8, lastSeq: 8, resetRequired: true }),
            deliver: (push) => delivered.push(push.seq ?? 0),
            recoverSnapshot: async () => {
                attempts++;
                return { recovered: false };
            },
            reportError: (message, error) => reports.push([message, error]),
            snapshotRetryDelaysMs: [0, 0, 0],
        });

        await processor.process(frame(1));
        await processor.process(frame(8));

        // 1 initial + 3 configured retries, then it gives up without advancing the cursor.
        assert.equal(attempts, 4);
        assert.equal(processor.last("/workspace", "session"), 1);
        assert.deepEqual(delivered, [1]);
        // Exhaustion reports once. `recovered: false` carries no cause, so the
        // error argument stays undefined rather than a synthesised Error.
        assert.equal(reports.length, 1);
        assert.match(reports[0]?.[0] ?? "", /session snapshot recovery failed/);
        assert.equal(reports[0]?.[1], undefined);
    });

    it("stops retrying as soon as a snapshot succeeds", async () => {
        let attempts = 0;
        const processor = new SessionPushProcessor({
            getEvents: async (_w, _s, afterSeq) =>
                afterSeq === 1
                    ? { events: [], firstSeq: 8, lastSeq: 8, resetRequired: true }
                    : { events: [frame(8)], firstSeq: 1, lastSeq: 8, resetRequired: false },
            deliver: () => {},
            recoverSnapshot: async () => {
                attempts++;
                // Fail once (busy session), then converge on the second attempt.
                return attempts < 2 ? { recovered: false } : { recovered: true, snapshotSeq: 7 };
            },
            reportError: (message) => assert.fail(message),
            snapshotRetryDelaysMs: [0, 0, 0],
        });

        await processor.process(frame(1));
        await processor.process(frame(8));

        // Short-circuits on success: 2 attempts, not the full 4.
        assert.equal(attempts, 2);
        assert.equal(processor.last("/workspace", "session"), 8);
    });

    it("throttles repeated snapshot-exhaustion reports", async () => {
        const reports: string[] = [];
        const processor = new SessionPushProcessor({
            getEvents: async () => ({ events: [], firstSeq: 8, lastSeq: 8, resetRequired: true }),
            deliver: () => {},
            recoverSnapshot: async () => ({ recovered: false }),
            reportError: (message) => reports.push(message),
            snapshotRetryDelaysMs: [],
        });

        await processor.process(frame(1));
        // Each frame re-runs a doomed recovery; only the first report escapes
        // the 5s window, so a permanently broken session stays quiet.
        await processor.process(frame(8));
        await processor.process(frame(9));
        await processor.process(frame(10));

        assert.equal(reports.length, 1);
    });

    it("throttles mid-stream gap-recovery failures to one report per 5s", async () => {
        const reports: string[] = [];
        const processor = new SessionPushProcessor({
            getEvents: async () => {
                throw new Error("sidecar not started");
            },
            deliver: () => {},
            recoverSnapshot: async () => assert.fail("snapshot should not be needed"),
            reportError: (message) => reports.push(message),
            snapshotRetryDelaysMs: [],
        });

        // First frame is accepted (afterSeq=0 → cursor=1). The next frame is
        // a gap with afterSeq=1 → triggers recoverGap failure.
        await processor.process(frame(1));
        const beforeGap = Date.now();
        await processor.process(frame(3));
        await processor.process(frame(4));
        await processor.process(frame(5));
        // Subsequent failures within the throttle window are suppressed.
        assert.equal(reports.length, 1);
        assert.match(reports[0] ?? "", /session event replay failed/);

        // Advance the clock past the window.
        const nowSpy = Date.now;
        Date.now = () => beforeGap + 6000;
        try {
            await processor.process(frame(6));
        } finally {
            Date.now = nowSpy;
        }
        assert.equal(reports.length, 2);
    });
});

it("invalidates an old replay on clear while new work can proceed", async () => {
    let resolve!: (value: SessionEventsGetResult) => void;
    const slow = new Promise<SessionEventsGetResult>((r) => {
        resolve = r;
    });
    const delivered: number[] = [];
    const processor = new SessionPushProcessor({
        getEvents: () => slow,
        deliver: (push) => delivered.push(push.seq ?? 0),
        recoverSnapshot: async () => ({ recovered: false }),
        reportError: (message) => assert.fail(message),
    });
    const old = processor.process(frame(3));
    await Promise.resolve();
    processor.clear();
    await processor.process(frame(1));
    resolve({
        events: [frame(1), frame(2), frame(3)],
        firstSeq: 1,
        lastSeq: 3,
        resetRequired: false,
    });
    await old;
    assert.deepEqual(delivered, [1]);
    assert.equal(processor.last("/workspace", "session"), 1);
});

it("finishes event synchronization after an idle legacy snapshot without lifecycle events", async () => {
    const states: string[] = [];
    const processor = new SessionPushProcessor({
        getEvents: async (_w, _s, afterSeq) =>
            afterSeq === 0
                ? { events: [], firstSeq: 8, lastSeq: 9, resetRequired: true }
                : { events: [], firstSeq: 8, lastSeq: 9, resetRequired: false },
        deliver: () => {},
        recoverSnapshot: async () => ({ recovered: true, snapshotSeq: 9 }),
        reportError: (message) => assert.fail(message),
        onSyncState: (_workspace, _session, sync) => states.push(sync),
    });
    await processor.reconcile("/workspace", "session");
    assert.deepEqual(states, ["recovering", "current"]);
    await processor.reconcile("/workspace", "session");
    assert.deepEqual(states, ["recovering", "current", "recovering", "current"]);
});

it("finishes synchronization without delivering an old duplicate run_end after snapshot", async () => {
    const states: string[] = [];
    const processor = new SessionPushProcessor({
        getEvents: async (_w, _s, afterSeq) =>
            afterSeq === 0
                ? { events: [], firstSeq: 5, lastSeq: 5, resetRequired: true }
                : {
                      events: [{ ...frame(5), params: { event: { type: "run_end" } } }],
                      firstSeq: 5,
                      lastSeq: 5,
                      resetRequired: false,
                  },
        deliver: () => assert.fail("old run_end must not be delivered"),
        recoverSnapshot: async () => ({ recovered: true, snapshotSeq: 5 }),
        reportError: (message) => assert.fail(message),
        onSyncState: (_workspace, _session, sync) => states.push(sync),
    });
    await processor.reconcile("/workspace", "session");
    assert.deepEqual(states, ["recovering", "current"]);
});

it("keeps a replay with a missing sequence incomplete even when its tail includes run_end", async () => {
    const states: string[] = [];
    const delivered: number[] = [];
    const processor = new SessionPushProcessor({
        getEvents: async () => ({
            events: [frame(3), { ...frame(4), params: { event: { type: "run_end" } } }],
            firstSeq: 1,
            lastSeq: 4,
            resetRequired: false,
        }),
        deliver: (push) => delivered.push(push.seq ?? 0),
        recoverSnapshot: async () => assert.fail("snapshot is not requested"),
        reportError: () => {},
        onSyncState: (_workspace, _session, sync) => states.push(sync),
    });
    await processor.process(frame(1));
    await processor.reconcile("/workspace", "session");
    assert.deepEqual(delivered, [1]);
    assert.equal(processor.last("/workspace", "session"), 1);
    assert.deepEqual(states, ["recovering", "incomplete"]);
});

it("retries failed reconciliation when the next push is contiguous", async () => {
    const states: string[] = [];
    const delivered: number[] = [];
    let attempts = 0;
    const processor = new SessionPushProcessor({
        getEvents: async () => {
            if (++attempts === 1) throw new Error("transient replay failure");
            return { events: [frame(2)], firstSeq: 1, lastSeq: 2, resetRequired: false };
        },
        deliver: (push) => delivered.push(push.seq ?? 0),
        recoverSnapshot: async () => assert.fail("snapshot is not required"),
        reportError: () => {},
        onSyncState: (_workspace, _session, sync) => states.push(sync),
    });
    await processor.process(frame(1));
    await processor.reconcile("/workspace", "session");
    assert.equal(states.at(-1), "incomplete");
    await processor.process(frame(2));
    assert.deepEqual(delivered, [1, 2]);
    assert.equal(processor.last("/workspace", "session"), 2);
    assert.equal(attempts, 2);
    assert.deepEqual(states, ["recovering", "incomplete", "recovering", "current"]);
});

it("forgets recovery failures for reset streams without clearing another workspace", async () => {
    let attempts = 0;
    const processor = new SessionPushProcessor({
        getEvents: async (workspace) => {
            if (++attempts <= 2) throw new Error("transient replay failure");
            return {
                events: [{ ...frame(2), workspace: asWorkspaceId(workspace) }],
                firstSeq: 1,
                lastSeq: 2,
                resetRequired: false,
            };
        },
        deliver: () => {},
        recoverSnapshot: async () => assert.fail("snapshot is not required"),
        reportError: () => {},
    });
    await processor.process(frame(1));
    await processor.process({ ...frame(1), workspace: asWorkspaceId("/other") });
    await processor.reconcile("/workspace", "session");
    await processor.reconcile("/other", "session");
    processor.resetWorkspace("/workspace");
    await processor.process(frame(1));
    assert.equal(attempts, 2);
    await processor.process({ ...frame(2), workspace: asWorkspaceId("/other") });
    assert.equal(attempts, 3);
    await processor.reconcile("/workspace", "session");
    processor.clear();
    const before = attempts;
    await processor.process(frame(1));
    assert.equal(attempts, before);
});

it("keeps execution unknown after snapshot catch-up until a new contiguous lifecycle event", async () => {
    let state: Record<string, WorkspaceState> = {
        "/workspace": createEmptyWorkspace("/workspace"),
    };
    const processor = new SessionPushProcessor({
        getEvents: async (_workspace, _session, afterSeq) => ({
            events: [],
            firstSeq: 8,
            lastSeq: 9,
            resetRequired: afterSeq === 0,
        }),
        recoverSnapshot: async () => {
            state = workspacesReducer(state, {
                type: "RESTORE_SESSION_SNAPSHOT",
                cwd: "/workspace",
                sid: "session",
                sessionKind: "main",
                messages: [],
                sync: "recovering",
            });
            return { recovered: true, snapshotSeq: 9 };
        },
        deliver: (push) => {
            state = workspacesReducer(state, {
                type: "APPLY_EVENT",
                cwd: push.workspace,
                sid: push.session ?? "session",
                now: 1,
                suppressedThinking: false,
                ev: (push.params as { event: { type: "run_start" | "run_end" } }).event,
            });
        },
        onSyncState: (cwd, sid, sync) => {
            state = workspacesReducer(state, { type: "SET_SESSION_SYNC", cwd, sid, sync });
        },
        reportError: (message) => assert.fail(message),
    });
    await processor.reconcile("/workspace", "session");
    assert.equal(getSessionState(state["/workspace"], "session")?.sync, "current");
    assert.equal(getSessionState(state["/workspace"], "session")?.execution, "unknown");
    assert.equal(state["/workspace"]?.pendingBySessionId.session, undefined);
    await processor.process({ ...frame(10), params: { event: { type: "run_start" } } });
    assert.equal(getSessionState(state["/workspace"], "session")?.execution, "running");
    assert.equal(state["/workspace"]?.pendingBySessionId.session, true);
    await processor.process({ ...frame(11), params: { event: { type: "run_end" } } });
    assert.equal(getSessionState(state["/workspace"], "session")?.execution, "idle");
    assert.equal(getSessionState(state["/workspace"], "session")?.sync, "current");
});

it("probes execution when reconnecting with no missed lifecycle event", async () => {
    let state: Record<string, WorkspaceState> = {
        "/workspace": createEmptyWorkspace("/workspace"),
    };
    state = workspacesReducer(state, {
        type: "SESSION_UNCERTAIN",
        cwd: "/workspace",
        sid: "session",
    });
    const processor = new SessionPushProcessor({
        getEvents: async () => ({
            events: [],
            firstSeq: 0,
            lastSeq: 0,
            resetRequired: false,
        }),
        recoverSnapshot: async () => assert.fail("snapshot is not required"),
        probeExecution: async () => "running",
        onExecutionState: (cwd, sid, execution) => {
            state = workspacesReducer(state, {
                type: "SET_SESSION_EXECUTION",
                cwd,
                sid,
                execution,
            });
        },
        deliver: () => assert.fail("no event should be delivered"),
        onSyncState: (cwd, sid, sync) => {
            state = workspacesReducer(state, { type: "SET_SESSION_SYNC", cwd, sid, sync });
        },
        reportError: (message) => assert.fail(message),
    });

    await processor.reconcile("/workspace", "session");

    assert.equal(getSessionState(state["/workspace"], "session")?.execution, "running");
    assert.equal(getSessionState(state["/workspace"], "session")?.sync, "current");
    assert.equal(state["/workspace"]?.pendingBySessionId.session, true);
});
