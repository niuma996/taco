import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { WORK_LIST_DEFAULT_LIMIT } from "@taco-ai/protocol";
import {
    WORK_SCHEMA_VERSION,
    type WorkDelivery,
    type WorkRecord,
    type WorkStatus,
} from "../../src/work/workTypes.ts";
import { buildList, needsAttention, toSummary } from "../../src/work/workView.ts";

function delivery(over: Partial<WorkDelivery> = {}): WorkDelivery {
    return {
        deliveryId: "d-1",
        target: { channelId: "wechat-1", peerId: "secret-peer", chatId: "secret-chat" },
        status: "confirmed",
        chunks: ["x"],
        source: "template",
        maxMessageLength: 100,
        confirmedChunks: 1,
        attempts: 0,
        createdAt: 1,
        ...over,
    };
}

let seq = 0;
function record(over: Partial<WorkRecord> = {}): WorkRecord {
    const n = seq++;
    return {
        schemaVersion: WORK_SCHEMA_VERSION,
        workId: `w-${String(n).padStart(4, "0")}`,
        revision: 1,
        kind: "subagent",
        title: `t${n}`,
        sourceEventId: `subagent:p:${n}`,
        parentSessionId: "p",
        childSessionId: `c${n}`,
        agentType: "explorer",
        status: "completed",
        ownerInstanceId: "inst-1",
        createdAt: 1_000 + n,
        updatedAt: 1_000 + n,
        endedAt: 2_000 + n,
        attempt: { attemptId: "a", startedAt: 1_000 + n },
        ...over,
    };
}

describe("work.view", () => {
    it("reports target availability separately from execution and delivery", () => {
        assert.equal(toSummary(record({ workspace: "/a" })).sessionState, "available");
        assert.equal(toSummary(record({ workspace: undefined })).sessionState, "unavailable");
        const deleted = toSummary(record({ workspace: "/a", sessionState: "deleted" }));
        assert.equal(deleted.sessionState, "deleted");
        assert.equal(deleted.status, "completed");
        assert.equal(deleted.workspace, "/a");
        assert.equal(deleted.needsAttention, false);
    });

    describe("needsAttention", () => {
        it("flags an interrupted run", () => {
            assert.equal(needsAttention(record({ status: "interrupted" })), true);
        });

        it("flags a notice that gave up, expired, or was refused", () => {
            for (const status of ["retryExhausted", "expired", "permanentFailure"] as const) {
                assert.equal(
                    needsAttention(record({ delivery: delivery({ status }) })),
                    true,
                    status,
                );
            }
        });

        it("does not flag a finished run, a failed run, or a notice still on its way", () => {
            assert.equal(needsAttention(record()), false);
            assert.equal(needsAttention(record({ status: "failed" })), false);
            for (const status of ["pending", "confirmed", "handedOff", "cancelled"] as const) {
                assert.equal(needsAttention(record({ delivery: delivery({ status }) })), false);
            }
        });
    });

    describe("toSummary", () => {
        it("never carries the peer or chat id, only the channel", () => {
            const summary = toSummary(record({ delivery: delivery() }));
            assert.equal(summary.delivery?.channelId, "wechat-1");
            assert.equal(JSON.stringify(summary).includes("secret"), false);
        });

        it("leaves optional fields out rather than sending undefined", () => {
            const summary = toSummary(record());
            assert.equal("delivery" in summary, false);
            assert.equal("reason" in summary, false);
            assert.equal("workspace" in summary, false);
        });

        it("carries the workspace and the summary line when known", () => {
            const summary = toSummary(
                record({
                    workspace: "/w",
                    result: {
                        resultId: "r",
                        checksum: "c",
                        completeness: "partial",
                        summary: "found it",
                    },
                }),
            );
            assert.equal(summary.workspace, "/w");
            assert.equal(summary.completeness, "partial");
            assert.equal(summary.summary, "found it");
        });
    });

    describe("buildList", () => {
        const inst = "inst-1";

        it("puts running and attention-needing Works in active, newest first", () => {
            const running = record({ status: "running", endedAt: undefined, createdAt: 5_000 });
            const lost = record({ status: "interrupted", createdAt: 6_000 });
            const gaveUp = record({
                delivery: delivery({ status: "retryExhausted" }),
                createdAt: 4_000,
            });
            const done = record({ createdAt: 9_000 });
            const list = buildList([done, gaveUp, running, lost], {}, inst);
            assert.deepEqual(
                list.active.map((w) => w.workId),
                [lost.workId, running.workId, gaveUp.workId],
            );
            assert.deepEqual(
                list.terminal.map((w) => w.workId),
                [done.workId],
            );
            assert.equal(list.instanceId, inst);
        });

        it("returns every active Work whole, however many there are", () => {
            const many = Array.from({ length: WORK_LIST_DEFAULT_LIMIT + 20 }, () =>
                record({ status: "running", endedAt: undefined }),
            );
            const list = buildList(many, { limit: 1 }, inst);
            assert.equal(list.active.length, many.length);
            assert.equal(list.nextCursor, undefined);
        });

        it("pages finished Works newest first with a cursor and no overlap", () => {
            const all = Array.from({ length: 7 }, () => record());
            const seen: string[] = [];
            let before: string | undefined;
            let pages = 0;
            do {
                const page = buildList(all, { limit: 3, before }, inst);
                seen.push(...page.terminal.map((w) => w.workId));
                before = page.nextCursor;
                pages++;
            } while (before !== undefined && pages < 10);
            assert.equal(pages, 3);
            assert.equal(new Set(seen).size, 7, "no row twice");
            const expected = [...all].sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
            assert.deepEqual(
                seen,
                expected.map((w) => w.workId),
            );
        });

        it("a Work that finishes between two pages does not shift rows already seen", () => {
            const all = Array.from({ length: 6 }, () => record());
            const first = buildList(all, { limit: 3 }, inst);
            const newest = record({ endedAt: 99_999, createdAt: 99_000 });
            const second = buildList(
                [...all, newest],
                { limit: 3, before: first.nextCursor },
                inst,
            );
            const firstIds = new Set(first.terminal.map((w) => w.workId));
            assert.equal(
                second.terminal.some((w) => firstIds.has(w.workId)),
                false,
            );
            assert.equal(
                second.terminal.some((w) => w.workId === newest.workId),
                false,
                "it belongs to page one of a fresh listing, not to the continuation",
            );
        });

        it("breaks ties on the same end time by id, so the order is total", () => {
            const a = record({ endedAt: 7_000 });
            const b = record({ endedAt: 7_000 });
            const c = record({ endedAt: 7_000 });
            const seen: string[] = [];
            let before: string | undefined;
            for (let i = 0; i < 5; i++) {
                const page = buildList([a, b, c], { limit: 1, before }, inst);
                seen.push(...page.terminal.map((w) => w.workId));
                before = page.nextCursor;
                if (before === undefined) break;
            }
            assert.equal(new Set(seen).size, 3);
        });

        it("ignores a malformed cursor instead of failing", () => {
            const all = [record(), record()];
            const list = buildList(all, { before: "not-a-cursor" }, inst);
            assert.equal(list.terminal.length, 2);
        });

        it("groups every terminal status without a delivery problem into terminal", () => {
            const statuses: WorkStatus[] = ["completed", "failed", "cancelled"];
            const list = buildList(
                statuses.map((status) => record({ status })),
                {},
                inst,
            );
            assert.equal(list.active.length, 0);
            assert.equal(list.terminal.length, 3);
        });

        it("narrows to one job's fires when asked", () => {
            const fireA = record({ kind: "scheduled", jobId: "a", agentType: undefined });
            const fireB = record({ kind: "scheduled", jobId: "b", agentType: undefined });
            const running = record({ kind: "scheduled", jobId: "a", status: "running" });
            const list = buildList([fireA, fireB, running, record()], { jobId: "a" }, "inst-1");
            assert.deepEqual(
                [...list.active, ...list.terminal].map((w) => w.workId).sort(),
                [fireA.workId, running.workId].sort(),
            );
        });
    });

    describe("scheduled summary", () => {
        it("names the session it ran in and the job, with no subagent fields", () => {
            const summary = toSummary(
                record({
                    kind: "scheduled",
                    jobId: "daily",
                    parentSessionId: "sched-pin-daily",
                    childSessionId: undefined,
                    agentType: undefined,
                }),
            );
            assert.equal(summary.kind, "scheduled");
            assert.equal(summary.jobId, "daily");
            assert.equal(summary.sessionId, "sched-pin-daily");
            assert.equal("childSessionId" in summary, false);
            assert.equal("agentType" in summary, false);
        });
    });
});
