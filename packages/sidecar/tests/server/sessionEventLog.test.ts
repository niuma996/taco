import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SessionEventLog } from "../../src/server/sessionEventLog.ts";

describe("SessionEventLog", () => {
    it("replays all frames after the supplied cursor in sequence order", () => {
        const log = new SessionEventLog(3);
        log.append("/workspace", "session", (seq) => ({
            method: "session.event",
            workspace: "/workspace",
            session: "session",
            seq,
            params: { seq },
        }));
        log.append("/workspace", "session", (seq) => ({
            method: "session.event",
            workspace: "/workspace",
            session: "session",
            seq,
            params: { seq },
        }));

        const replay = log.replay("/workspace", "session", 0);

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
            log.append("/workspace", "session", (seq) => ({
                method: "session.event",
                workspace: "/workspace",
                session: "session",
                seq,
                params: { seq },
            }));
        }

        const replay = log.replay("/workspace", "session", 0);

        assert.equal(replay.resetRequired, true);
        assert.equal(replay.firstSeq, 2);
        assert.equal(replay.lastSeq, 3);
        assert.deepEqual(replay.events, []);
        assert.equal(log.lastSeq("/workspace", "session"), 3);
    });

    it("releases one session without disturbing other streams", () => {
        const log = new SessionEventLog();
        log.append("/workspace", "drop", (seq) => ({
            method: "session.event",
            workspace: "/workspace",
            session: "drop",
            seq,
            params: {},
        }));
        log.append("/workspace", "keep", (seq) => ({
            method: "session.event",
            workspace: "/workspace",
            session: "keep",
            seq,
            params: {},
        }));

        log.clearSession("/workspace", "drop");

        assert.deepEqual(log.replay("/workspace", "drop", 0), {
            events: [],
            firstSeq: 1,
            lastSeq: 0,
            resetRequired: false,
        });
        assert.deepEqual(
            log.replay("/workspace", "keep", 0).events.map((event) => event.seq),
            [1],
        );
    });

    it("releases every stream for a disposed workspace", () => {
        const log = new SessionEventLog();
        for (const workspace of ["/dispose", "/keep"]) {
            log.append(workspace, "session", (seq) => ({
                method: "session.event",
                workspace,
                session: "session",
                seq,
                params: {},
            }));
        }

        log.clearWorkspace("/dispose");

        assert.equal(log.replay("/dispose", "session", 0).lastSeq, 0);
        assert.equal(log.replay("/keep", "session", 0).lastSeq, 1);
    });
});

describe("SessionEventLog — terminal tombstone (session.deleted)", () => {
    it("appended after N events continues seq (not reset to 1)", () => {
        const log = new SessionEventLog();
        const ws = "/workspace";
        const sid = "session";
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
        const ws = "/workspace";
        const sid = "session";
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
