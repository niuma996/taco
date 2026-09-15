import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { asSessionId, asWorkspaceId } from "@taco-ai/protocol";
import { DurablePushLog } from "../../src/server/durablePushLog.ts";
import { SessionEventLog } from "../../src/server/sessionEventLog.ts";

describe("SessionEventLog", () => {
    it("replays all frames after the supplied cursor in sequence order", () => {
        const log = new SessionEventLog(3);
        log.append(asWorkspaceId("/workspace"), asSessionId("session"), (seq) => ({
            method: "session.event",
            workspace: asWorkspaceId("/workspace"),
            session: asSessionId("session"),
            seq,
            params: { seq },
        }));
        log.append(asWorkspaceId("/workspace"), asSessionId("session"), (seq) => ({
            method: "session.event",
            workspace: asWorkspaceId("/workspace"),
            session: asSessionId("session"),
            seq,
            params: { seq },
        }));

        const replay = log.replay(asWorkspaceId("/workspace"), asSessionId("session"), 0);

        assert.equal(replay.resetRequired, false);
        assert.deepEqual(
            replay.events.map((event) => event.seq),
            [1, 2],
        );
        assert.equal(replay.lastSeq, 2);
    });

    it("requires a snapshot when the requested cursor predates retained frames", () => {
        const log = new SessionEventLog(2);
        for (let index = 0; index < 3; index++) {
            log.append(asWorkspaceId("/workspace"), asSessionId("session"), (seq) => ({
                method: "session.event",
                workspace: asWorkspaceId("/workspace"),
                session: asSessionId("session"),
                seq,
                params: { seq },
            }));
        }

        const replay = log.replay(asWorkspaceId("/workspace"), asSessionId("session"), 0);

        assert.equal(replay.resetRequired, true);
        assert.equal(replay.firstSeq, 2);
        assert.equal(replay.lastSeq, 3);
        assert.deepEqual(replay.events, []);
        assert.equal(log.lastSeq(asWorkspaceId("/workspace"), asSessionId("session")), 3);
    });

    it("releases one session without disturbing other streams", () => {
        const log = new SessionEventLog();
        log.append(asWorkspaceId("/workspace"), asSessionId("drop"), (seq) => ({
            method: "session.event",
            workspace: asWorkspaceId("/workspace"),
            session: asSessionId("drop"),
            seq,
            params: {},
        }));
        log.append(asWorkspaceId("/workspace"), asSessionId("keep"), (seq) => ({
            method: "session.event",
            workspace: asWorkspaceId("/workspace"),
            session: asSessionId("keep"),
            seq,
            params: {},
        }));

        log.clearSession(asWorkspaceId("/workspace"), asSessionId("drop"));

        assert.deepEqual(log.replay(asWorkspaceId("/workspace"), asSessionId("drop"), 0), {
            events: [],
            firstSeq: 1,
            lastSeq: 0,
            resetRequired: false,
        });
        assert.deepEqual(
            log
                .replay(asWorkspaceId("/workspace"), asSessionId("keep"), 0)
                .events.map((event) => event.seq),
            [1],
        );
    });

    it("releases every stream for a disposed workspace", () => {
        const log = new SessionEventLog();
        for (const workspace of [asWorkspaceId("/dispose"), asWorkspaceId("/keep")]) {
            log.append(asWorkspaceId(workspace), asSessionId("session"), (seq) => ({
                method: "session.event",
                workspace,
                session: asSessionId("session"),
                seq,
                params: {},
            }));
        }

        log.clearWorkspace(asWorkspaceId("/dispose"));

        assert.equal(log.replay(asWorkspaceId("/dispose"), asSessionId("session"), 0).lastSeq, 0);
        assert.equal(log.replay(asWorkspaceId("/keep"), asSessionId("session"), 0).lastSeq, 1);
    });
});

describe("SessionEventLog — terminal tombstone (session.deleted)", () => {
    it("appended after N events continues seq (not reset to 1)", () => {
        const log = new SessionEventLog();
        const ws = asWorkspaceId("/workspace");
        const sid = asSessionId("session");
        for (let i = 0; i < 5; i++) {
            log.append(ws, sid, (seq) => ({
                method: "session.event",
                workspace: ws,
                session: sid,
                seq,
                params: {},
            }));
        }
        const tombstone = log.append(ws, sid, (seq) => ({
            method: "session.deleted",
            workspace: ws,
            session: sid,
            seq,
            params: {},
        }));
        assert.equal(tombstone.seq, 6);
        assert.notEqual(tombstone.seq, 1);
        const replay = log.replay(ws, sid, 5);
        assert.equal(replay.events.length, 1);
        assert.equal(replay.events[0]?.method, "session.deleted");
        assert.equal(replay.events[0]?.seq, 6);
    });

    it("clearSession before append resets seq to 1 (the anti-pattern)", () => {
        // Regression contrast: clearing first creates a fresh stream whose
        // seq starts at 1 — a client that consumed seq=N discards it as a
        // duplicate. The session.deleted listener must NOT clear first.
        const log = new SessionEventLog();
        const ws = asWorkspaceId("/workspace");
        const sid = asSessionId("session");
        for (let i = 0; i < 5; i++) {
            log.append(ws, sid, (seq) => ({
                method: "session.event",
                workspace: ws,
                session: sid,
                seq,
                params: {},
            }));
        }
        log.clearSession(ws, sid);
        const after = log.append(ws, sid, (seq) => ({
            method: "session.deleted",
            workspace: ws,
            session: sid,
            seq,
            params: {},
        }));
        assert.equal(after.seq, 1);
    });
});

describe("SessionEventLog — hydrate from disk tail", () => {
    let root: string;
    before(async () => {
        root = await mkdtemp(join(tmpdir(), "taco-event-log-"));
    });
    after(async () => {
        await rm(root, { recursive: true, force: true });
    });

    function emit(
        log: SessionEventLog,
        ws: ReturnType<typeof asWorkspaceId>,
        sid: ReturnType<typeof asSessionId>,
    ) {
        return log.append(ws, sid, (seq) => ({
            method: "session.event" as const,
            workspace: ws,
            session: sid,
            seq,
            params: {},
        }));
    }

    it("continues seq across a simulated process restart", async () => {
        const ws = asWorkspaceId("/ws");
        const sid = asSessionId("restart");
        const disk = new DurablePushLog(root, { flushDelayMs: 1 });
        const first = new SessionEventLog(4, disk);
        for (let i = 0; i < 3; i++) emit(first, ws, sid);
        // Graceful shutdown: drains the buffer and releases the stream claim so
        // the next ring can take it over (see DurablePushLog.claim).
        await first.flushDurable();

        // New process: fresh ring over the same disk tail.
        const restarted = new SessionEventLog(4, disk);
        await restarted.hydrate(ws, sid);
        const next = emit(restarted, ws, sid);

        assert.equal(next.seq, 4);
        assert.equal(restarted.lastSeq(ws, sid), 4);
        const replay = restarted.replay(ws, sid, 2);
        assert.equal(replay.resetRequired, false);
        assert.deepEqual(
            replay.events.map((event) => event.seq),
            [3, 4],
        );
    });

    it("is a no-op while the in-memory ring is live", async () => {
        const ws = asWorkspaceId("/ws");
        const sid = asSessionId("live");
        const disk = new DurablePushLog(root, { flushDelayMs: 1 });
        const log = new SessionEventLog(4, disk);
        emit(log, ws, sid);
        emit(log, ws, sid);
        await log.hydrate(ws, sid);
        const next = emit(log, ws, sid);

        assert.equal(next.seq, 3);
    });

    it("leaves a brand-new session untouched (first frame stays seq 1)", async () => {
        const ws = asWorkspaceId("/ws");
        const sid = asSessionId("fresh");
        const disk = new DurablePushLog(root, { flushDelayMs: 1 });
        const log = new SessionEventLog(4, disk);
        await log.hydrate(ws, sid);
        const first = emit(log, ws, sid);

        assert.equal(first.seq, 1);
    });

    // Two live rings over one tail is the two-connections-one-session case.
    // Each numbers seqs independently, so the tail must follow exactly one of
    // them; the other degrades to snapshot recovery.
    it("does not interleave two live rings sharing one tail", async () => {
        const ws = asWorkspaceId("/ws");
        const sid = asSessionId("contended");
        const disk = new DurablePushLog(root, { flushDelayMs: 1 });
        const owner = new SessionEventLog(8, disk);
        const other = new SessionEventLog(8, disk);

        emit(owner, ws, sid);
        emit(owner, ws, sid);
        emit(other, ws, sid); // seq 1 again, from its own ring
        await owner.flushDurable();

        const restarted = new SessionEventLog(8, disk);
        await restarted.hydrate(ws, sid);
        // 2 from the owner, not 1 from the loser or a 1,2,1 mixture.
        assert.equal(restarted.lastSeq(ws, sid), 2);
        assert.equal(emit(restarted, ws, sid).seq, 3);
    });

    it("without a DurablePushLog hydrate is a no-op", async () => {
        const ws = asWorkspaceId("/ws");
        const sid = asSessionId("nodisk");
        const log = new SessionEventLog();
        await log.hydrate(ws, sid);
        assert.equal(log.lastSeq(ws, sid), 0);
        const first = emit(log, ws, sid);
        assert.equal(first.seq, 1);
    });

    it("clearSession drops the disk tail; clear() keeps it", async () => {
        const ws = asWorkspaceId("/ws");
        const sid = asSessionId("gone");
        const disk = new DurablePushLog(root, { flushDelayMs: 1 });
        const log = new SessionEventLog(4, disk);
        emit(log, ws, sid);
        await log.flushDurable();

        log.clearSession(ws, sid);
        const freshLog = new SessionEventLog(4, disk);
        await freshLog.hydrate(ws, sid);
        assert.equal(freshLog.lastSeq(ws, sid), 0);

        // Process-level clear() is the restart path — disk must survive it.
        const survivor = asSessionId("survivor");
        const keepLog = new SessionEventLog(4, disk);
        emit(keepLog, ws, survivor);
        await keepLog.flushDurable();
        keepLog.clear();
        const restarted = new SessionEventLog(4, disk);
        await restarted.hydrate(ws, survivor);
        assert.equal(restarted.lastSeq(ws, survivor), 1);
    });
});
