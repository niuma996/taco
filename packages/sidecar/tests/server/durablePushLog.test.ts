import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { asSessionId, asWorkspaceId, type ServerPush } from "@taco-ai/protocol";
import { DurablePushLog } from "../../src/server/durablePushLog.ts";

const WS = asWorkspaceId("/ws");

// Stand-in for a SessionEventLog: the append claim is identity-based, so tests
// only need a distinct object per notional ring.
const ring = (): object => ({});

function frame(session: string, seq: number, params: Record<string, unknown> = {}): ServerPush {
    return {
        method: "session.event",
        workspace: WS,
        session: asSessionId(session),
        seq,
        params,
    };
}

/** Resolve the on-disk filename for a stream without duplicating the hash. */
async function soleFile(dir: string): Promise<string> {
    const names = await readdir(dir);
    assert.equal(names.length, 1, `expected exactly one tail file, got ${names.join(", ")}`);
    return join(dir, names[0] as string);
}

describe("DurablePushLog", () => {
    let root: string;
    before(async () => {
        root = await mkdtemp(join(tmpdir(), "taco-push-log-"));
    });
    after(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it("round-trips buffered frames through flush and loadTail", async () => {
        const disk = new DurablePushLog(root, { flushDelayMs: 1 });
        const owner = ring();
        const sid = asSessionId("roundtrip");
        disk.scheduleAppend(frame(sid, 1), owner);
        disk.scheduleAppend(frame(sid, 2, { delta: "x" }), owner);

        const tail = await disk.loadTail(WS, sid, 512, owner);

        assert.deepEqual(
            tail.map((event) => event.seq),
            [1, 2],
        );
        assert.equal((tail[1]?.params as { delta?: string }).delta, "x");
    });

    it("respects the limit and returns the most recent frames", async () => {
        const disk = new DurablePushLog(root, { flushDelayMs: 1 });
        const owner = ring();
        const sid = asSessionId("limit");
        for (let seq = 1; seq <= 5; seq++) disk.scheduleAppend(frame(sid, seq), owner);

        const tail = await disk.loadTail(WS, sid, 2, owner);

        assert.deepEqual(
            tail.map((event) => event.seq),
            [4, 5],
        );
    });

    it("repairs a torn final line instead of returning or propagating it", async () => {
        const sid = asSessionId("torn");
        const dir = await mkdtemp(join(tmpdir(), "taco-push-log-"));
        try {
            const owner = ring();
            // Seed the file through the log itself so the name matches the
            // (workspace, session) key the reader will derive.
            const seed = new DurablePushLog(dir, { flushDelayMs: 1 });
            seed.scheduleAppend(frame(sid, 1), owner);
            await seed.flush();
            const path = await soleFile(dir);
            const good = await readFile(path, "utf8");
            const torn = `${JSON.stringify(frame(sid, 2)).slice(0, 12)}{"seq":3`;
            await writeFile(path, `${good}${torn}`, "utf8");

            const disk = new DurablePushLog(dir, { flushDelayMs: 1 });
            const reader = ring();
            const tail = await disk.loadTail(WS, sid, 512, reader);

            assert.deepEqual(
                tail.map((event) => event.seq),
                [1],
            );
            // The file is repaired: a later append cannot weld onto the torn line.
            disk.scheduleAppend(frame(sid, 2), reader);
            await disk.loadTail(WS, sid, 512, reader);
            const raw = await readFile(path, "utf8");
            const parsedLines = raw
                .split("\n")
                .filter((line) => line !== "")
                .map((line) => JSON.parse(line) as { seq: number });
            assert.deepEqual(
                parsedLines.map((entry) => entry.seq),
                [1, 2],
            );
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("compacts a file that exceeds maxFileBytes to the newest keep lines", async () => {
        const sid = asSessionId("compact");
        const dir = await mkdtemp(join(tmpdir(), "taco-push-log-"));
        try {
            const owner = ring();
            const disk = new DurablePushLog(dir, { flushDelayMs: 1, maxFileBytes: 200, keep: 3 });
            for (let seq = 1; seq <= 10; seq++) {
                disk.scheduleAppend(frame(sid, seq, { pad: "0123456789".repeat(2) }), owner);
                await disk.loadTail(WS, sid, 1, owner); // forces a flush through the chain
            }

            const tail = await disk.loadTail(WS, sid, 512, owner);
            assert.deepEqual(
                tail.map((event) => event.seq),
                [8, 9, 10],
            );
            const raw = await readFile(await soleFile(dir), "utf8");
            assert.ok(raw.length < 200 * 10);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("remove deletes the file and drops buffered frames", async () => {
        const sid = asSessionId("removed");
        const dir = await mkdtemp(join(tmpdir(), "taco-push-log-"));
        try {
            const owner = ring();
            const disk = new DurablePushLog(dir, { flushDelayMs: 60_000 });
            disk.scheduleAppend(frame(sid, 1), owner);
            disk.remove(WS, sid);
            await disk.flush();

            const tail = await disk.loadTail(WS, sid, 512, owner);
            assert.deepEqual(tail, []);
            assert.equal(await readdir(dir).then((names) => names.length), 0);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("keeps streams isolated in per-stream files", async () => {
        const dir = await mkdtemp(join(tmpdir(), "taco-push-log-"));
        try {
            const owner = ring();
            const disk = new DurablePushLog(dir, { flushDelayMs: 1 });
            disk.scheduleAppend(frame("iso-a", 1), owner);
            disk.scheduleAppend(frame("iso-b", 1), owner);

            const a = await disk.loadTail(WS, asSessionId("iso-a"), 512, owner);
            const b = await disk.loadTail(WS, asSessionId("iso-b"), 512, owner);
            assert.equal(a.length, 1);
            assert.equal(b.length, 1);
            assert.equal(await readdir(dir).then((names) => names.length), 2);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    // The ring key is (workspace, session); a client may supply its own session
    // id to session.create, so two workspaces can legitimately share one.
    it("separates the same session id across two workspaces", async () => {
        const dir = await mkdtemp(join(tmpdir(), "taco-push-log-"));
        try {
            const owner = ring();
            const other = asWorkspaceId("/other-ws");
            const sid = asSessionId("shared-id");
            const disk = new DurablePushLog(dir, { flushDelayMs: 1 });

            disk.scheduleAppend({ ...frame(sid, 1), workspace: WS }, owner);
            disk.scheduleAppend({ ...frame(sid, 7), workspace: other, params: { x: 1 } }, owner);

            const a = await disk.loadTail(WS, sid, 512, owner);
            const b = await disk.loadTail(other, sid, 512, owner);
            assert.deepEqual(
                a.map((e) => e.seq),
                [1],
            );
            assert.deepEqual(
                b.map((e) => e.seq),
                [7],
            );
            assert.equal(await readdir(dir).then((names) => names.length), 2);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    describe("append claim", () => {
        it("admits only the first ring to touch a stream", async () => {
            const dir = await mkdtemp(join(tmpdir(), "taco-push-log-"));
            try {
                const first = ring();
                const second = ring();
                const sid = asSessionId("contended");
                const disk = new DurablePushLog(dir, { flushDelayMs: 1 });

                disk.scheduleAppend(frame(sid, 1), first);
                // Second ring restarts numbering at 1; interleaving the two would
                // make the tail hydrate a sequence that never existed.
                disk.scheduleAppend(frame(sid, 1, { from: "second" }), second);
                disk.scheduleAppend(frame(sid, 2), first);

                const tail = await disk.loadTail(WS, sid, 512, first);
                assert.deepEqual(
                    tail.map((event) => event.seq),
                    [1, 2],
                );
                assert.ok(
                    tail.every((event) => (event.params as { from?: string }).from === undefined),
                    "the losing ring's frame must not be persisted",
                );
            } finally {
                await rm(dir, { recursive: true, force: true });
            }
        });

        it("returns an empty tail to a ring that does not hold the claim", async () => {
            const dir = await mkdtemp(join(tmpdir(), "taco-push-log-"));
            try {
                const first = ring();
                const sid = asSessionId("claimed");
                const disk = new DurablePushLog(dir, { flushDelayMs: 1 });
                disk.scheduleAppend(frame(sid, 1), first);
                await disk.flush();

                // A non-owner must not adopt seqs it will then be unable to extend.
                assert.deepEqual(await disk.loadTail(WS, sid, 512, ring()), []);
                assert.equal((await disk.loadTail(WS, sid, 512, first)).length, 1);
            } finally {
                await rm(dir, { recursive: true, force: true });
            }
        });

        it("hands the claim over after releaseOwner", async () => {
            const dir = await mkdtemp(join(tmpdir(), "taco-push-log-"));
            try {
                const first = ring();
                const second = ring();
                const sid = asSessionId("handover");
                const disk = new DurablePushLog(dir, { flushDelayMs: 1 });

                disk.scheduleAppend(frame(sid, 1), first);
                await disk.flush();
                disk.releaseOwner(first);

                // A reconnecting client must be able to continue the stream.
                const tail = await disk.loadTail(WS, sid, 512, second);
                assert.deepEqual(
                    tail.map((event) => event.seq),
                    [1],
                );
                disk.scheduleAppend(frame(sid, 2), second);
                const extended = await disk.loadTail(WS, sid, 512, second);
                assert.deepEqual(
                    extended.map((event) => event.seq),
                    [1, 2],
                );
            } finally {
                await rm(dir, { recursive: true, force: true });
            }
        });
    });

    describe("flush", () => {
        it("drains frames whose timer has not fired yet", async () => {
            const dir = await mkdtemp(join(tmpdir(), "taco-push-log-"));
            try {
                const owner = ring();
                // A window far longer than the test: only an explicit flush can
                // land these, which is the graceful-shutdown case.
                const disk = new DurablePushLog(dir, { flushDelayMs: 60_000 });
                const sid = asSessionId("shutdown");
                disk.scheduleAppend(frame(sid, 1), owner);
                disk.scheduleAppend(frame(sid, 2), owner);

                await disk.flush();

                const raw = await readFile(await soleFile(dir), "utf8");
                const seqs = raw
                    .split("\n")
                    .filter((line) => line !== "")
                    .map((line) => (JSON.parse(line) as { seq: number }).seq);
                assert.deepEqual(seqs, [1, 2]);
            } finally {
                await rm(dir, { recursive: true, force: true });
            }
        });
    });
});
