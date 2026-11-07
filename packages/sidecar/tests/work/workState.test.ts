/**
 * Work transitions: the rules that keep a finished Work finished and keep the
 * three axes (status, completeness, delivery) from leaking into each other.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
    completenessFor,
    interrupt,
    resumeAttempt,
    settle,
    waitForInput,
} from "../../src/work/workState.ts";
import { isTerminal, WORK_SCHEMA_VERSION, type WorkRecord } from "../../src/work/workTypes.ts";

function running(overrides: Partial<WorkRecord> = {}): WorkRecord {
    return {
        schemaVersion: WORK_SCHEMA_VERSION,
        workId: "w-1",
        revision: 0,
        kind: "subagent",
        title: "t",
        sourceEventId: "subagent:p:c",
        parentSessionId: "p",
        childSessionId: "c",
        agentType: "explorer",
        status: "running",
        ownerInstanceId: "inst-1",
        createdAt: 100,
        updatedAt: 100,
        attempt: { attemptId: "a-1", startedAt: 100 },
        ...overrides,
    };
}

describe("work.state", () => {
    describe("settle", () => {
        it("maps each outcome to its status and stamps the end time", () => {
            const cases = [
                ["completed", "completed"],
                ["error", "failed"],
                ["aborted", "cancelled"],
            ] as const;
            for (const [outcome, status] of cases) {
                const next = settle(running(), { outcome, now: 500 });
                assert.equal(next?.status, status);
                assert.equal(next?.endedAt, 500);
                assert.equal(next?.attempt.endedAt, 500);
            }
        });

        it("refuses to rewrite a Work that already ended: the first terminal state wins", () => {
            const done = settle(running(), { outcome: "completed", now: 500 });
            assert.ok(done);
            assert.equal(settle(done, { outcome: "error", now: 900 }), undefined);
            const cancelled = settle(running(), { outcome: "aborted", now: 500 });
            assert.ok(cancelled);
            assert.equal(settle(cancelled, { outcome: "completed", now: 900 }), undefined);
        });

        it("keeps the result reference and reason it was given", () => {
            const result = {
                resultId: "r-1",
                checksum: "c",
                completeness: "full" as const,
                summary: "s",
            };
            const next = settle(running(), { outcome: "error", result, reason: "boom", now: 5 });
            assert.deepEqual(next?.result, result);
            assert.equal(next?.reason, "boom");
        });
    });

    describe("interrupt", () => {
        it("marks a running Work interrupted", () => {
            const next = interrupt(running(), { reason: "gone", now: 700 });
            assert.equal(next?.status, "interrupted");
            assert.equal(next?.reason, "gone");
        });

        it("never downgrades a Work that finished", () => {
            const done = settle(running(), { outcome: "completed", now: 500 });
            assert.ok(done);
            assert.equal(interrupt(done, { reason: "gone", now: 700 }), undefined);
        });
    });

    describe("completenessFor", () => {
        it("is unavailable when there is no text, whatever the outcome", () => {
            for (const outcome of ["completed", "error", "aborted"] as const) {
                assert.equal(completenessFor({ outcome, hasText: false }), "unavailable");
            }
        });

        it("is full for a normal completion and partial for a capped one", () => {
            assert.equal(completenessFor({ outcome: "completed", hasText: true }), "full");
            assert.equal(
                completenessFor({ outcome: "completed", partial: true, hasText: true }),
                "partial",
            );
        });

        it("treats text left behind by a failed or stopped run as partial", () => {
            assert.equal(completenessFor({ outcome: "error", hasText: true }), "partial");
            assert.equal(completenessFor({ outcome: "aborted", hasText: true }), "partial");
        });
    });
});

describe("waiting", () => {
    it("is active and records the interaction target", () => {
        const current = running({ status: "running" });
        const next = waitForInput(current, {
            toolCallId: "tool-1",
            toolName: "askUser",
            sessionId: "child-1",
            now: 5,
        });
        assert.equal(next?.status, "waiting");
        assert.ok(next);
        assert.equal(isTerminal(next.status), false);
        assert.deepEqual(next?.waiting, {
            toolCallId: "tool-1",
            toolName: "askUser",
            sessionId: "child-1",
        });
    });

    it("reopens a waiting Work with a fresh attempt", () => {
        const waiting = waitForInput(running({ status: "running" }), {
            toolCallId: "tool-1",
            toolName: "planExit",
            sessionId: "child-1",
            now: 5,
        });
        assert.ok(waiting);
        const resumed = resumeAttempt(waiting, { attemptId: "attempt-2", now: 9 });
        assert.equal(resumed?.status, "running");
        assert.equal(resumed?.attempt.attemptId, "attempt-2");
        assert.equal(resumed?.attempt.startedAt, 9);
        assert.equal(resumed?.waiting, undefined);
        assert.equal(resumed?.attempt.endedAt, undefined);
    });

    it("does not overwrite a terminal Work or resume a running Work", () => {
        const done = { ...running({ status: "running" }), status: "completed" as const };
        assert.equal(
            waitForInput(done, {
                toolCallId: "tool-1",
                toolName: "askUser",
                sessionId: "child-1",
                now: 5,
            }),
            undefined,
        );
        const active = running({ status: "running" });
        assert.equal(resumeAttempt(active, { attemptId: "attempt-2", now: 9 }), undefined);
    });
});
