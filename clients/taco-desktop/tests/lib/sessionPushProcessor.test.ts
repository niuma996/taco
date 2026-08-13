import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ServerPush, SessionEventsGetResult } from "@taco-ai/protocol";
import { SessionPushProcessor } from "../../src/lib/sessionPushProcessor.ts";

function frame(seq: number): ServerPush {
    return {
        method: "session.event",
        workspace: "/workspace",
        session: "session",
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
