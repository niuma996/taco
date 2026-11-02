/**
 * WorkStore: durability, dedup across restarts, and the "never trust a path
 * from outside" rule.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { settle } from "../../src/work/workState.ts";
import {
    assertSafeWorkId,
    checksumOf,
    isSafeWorkId,
    WorkStore,
    workIdForSource,
} from "../../src/work/workStore.ts";
import { WORK_SCHEMA_VERSION, type WorkRecord } from "../../src/work/workTypes.ts";

function record(sourceEventId: string, overrides: Partial<WorkRecord> = {}): WorkRecord {
    return {
        schemaVersion: WORK_SCHEMA_VERSION,
        workId: workIdForSource(sourceEventId),
        revision: 0,
        kind: "subagent",
        title: "t",
        sourceEventId,
        parentSessionId: "p",
        childSessionId: "c",
        agentType: "explorer",
        status: "running",
        ownerInstanceId: "inst-1",
        createdAt: 1,
        updatedAt: 1,
        attempt: { attemptId: "a-1", startedAt: 1 },
        ...overrides,
    };
}

describe("work.store", () => {
    let root: string;

    before(() => {
        root = mkdtempSync(join(tmpdir(), "taco-work-store-"));
    });
    after(() => rmSync(root, { recursive: true, force: true }));

    it("creates once per source event, even when two launches race", async () => {
        const store = new WorkStore(join(root, "race"));
        const rec = record("subagent:p:race");
        const [a, b] = await Promise.all([store.createIfAbsent(rec), store.createIfAbsent(rec)]);
        assert.equal([a, b].filter((r) => r.created).length, 1, "exactly one creator wins");
        assert.equal(a.record.workId, b.record.workId);
        assert.equal((await store.list()).length, 1);
    });

    it("dedups across a restart: a fresh store instance sees the earlier Work", async () => {
        const dir = join(root, "restart");
        const rec = record("subagent:p:restart");
        const first = await new WorkStore(dir).createIfAbsent(rec);
        assert.equal(first.created, true);
        const second = await new WorkStore(dir).createIfAbsent({ ...rec, title: "different" });
        assert.equal(second.created, false);
        assert.equal(second.record.title, "t", "the original record is returned untouched");
    });

    it("serializes concurrent mutations so none is lost", async () => {
        const store = new WorkStore(join(root, "mutate"));
        const rec = record("subagent:p:mutate");
        await store.createIfAbsent(rec);
        await Promise.all(
            Array.from({ length: 20 }, () =>
                store.mutate(rec.workId, (w) => ({ ...w, title: `${w.title}x` })),
            ),
        );
        const final = await store.get(rec.workId);
        assert.equal(final?.title, `t${"x".repeat(20)}`);
        assert.equal(final?.revision, 20, "every write bumped the revision exactly once");
    });

    it("leaves the record alone when the update declines", async () => {
        const store = new WorkStore(join(root, "decline"));
        const rec = record("subagent:p:decline");
        await store.createIfAbsent(rec);
        const done = await store.mutate(rec.workId, (w) =>
            settle(w, { outcome: "completed", now: 5 }),
        );
        assert.equal(done?.record.status, "completed");
        assert.equal(done?.changed, true);
        const again = await store.mutate(rec.workId, (w) =>
            settle(w, { outcome: "error", now: 9 }),
        );
        assert.equal(again?.record.status, "completed");
        assert.equal(again?.changed, false, "the decline is reported, not implied");
        assert.equal(
            again?.record.revision,
            done?.record.revision,
            "a declined update writes nothing",
        );
    });

    it("leaves no temp files behind after writes", async () => {
        const dir = join(root, "tmpfiles");
        const store = new WorkStore(dir);
        const rec = record("subagent:p:tmp");
        await store.createIfAbsent(rec);
        await store.mutate(rec.workId, (w) => ({ ...w, title: "next" }));
        const entries = readdirSync(join(dir, rec.workId));
        assert.deepEqual(
            entries.filter((e) => e.endsWith(".tmp")),
            [],
        );
    });

    describe("results", () => {
        it("round-trips an answer and verifies its checksum", async () => {
            const store = new WorkStore(join(root, "results"));
            const rec = record("subagent:p:res");
            await store.createIfAbsent(rec);
            const stored = await store.writeResult({
                workId: rec.workId,
                attemptId: "a-1",
                text: "the answer",
                now: 1,
            });
            const read = await store.readResult(rec.workId, stored.resultId, stored.checksum);
            assert.equal(read?.text, "the answer");
            assert.equal(stored.checksum, checksumOf("the answer"));
        });

        it("rejects a result whose checksum does not match the record that points at it", async () => {
            const store = new WorkStore(join(root, "results-bad"));
            const rec = record("subagent:p:resbad");
            await store.createIfAbsent(rec);
            const stored = await store.writeResult({
                workId: rec.workId,
                attemptId: "a-1",
                text: "real",
                now: 1,
            });
            assert.equal(
                await store.readResult(rec.workId, stored.resultId, "0".repeat(64)),
                undefined,
            );
        });

        it("writing the same text twice yields the same result id", async () => {
            const store = new WorkStore(join(root, "results-same"));
            const rec = record("subagent:p:ressame");
            await store.createIfAbsent(rec);
            const a = await store.writeResult({
                workId: rec.workId,
                attemptId: "a",
                text: "x",
                now: 1,
            });
            const b = await store.writeResult({
                workId: rec.workId,
                attemptId: "a",
                text: "x",
                now: 2,
            });
            assert.equal(a.resultId, b.resultId);
        });
    });

    describe("ids and paths", () => {
        it("accepts derived ids and rejects anything that could leave the directory", () => {
            assert.ok(isSafeWorkId(workIdForSource("subagent:p:c")));
            for (const bad of [
                "",
                ".",
                "..",
                "../x",
                "a/b",
                "a\\b",
                "a b",
                "a\0b",
                "-lead",
                "x".repeat(200),
            ]) {
                assert.equal(isSafeWorkId(bad), false, JSON.stringify(bad));
                assert.throws(() => assertSafeWorkId(bad));
            }
        });

        it("refuses to read a result id that is not a plain id", async () => {
            const store = new WorkStore(join(root, "paths"));
            assert.equal(await store.readResult("w-x", "../../etc/passwd", "c"), undefined);
        });

        it("ignores directories that are not valid ids when listing", async () => {
            const dir = join(root, "stray");
            const store = new WorkStore(dir);
            await store.createIfAbsent(record("subagent:p:stray"));
            mkdirSync(join(dir, "not a valid id"), { recursive: true });
            assert.equal((await store.list()).length, 1);
        });
    });

    describe("damaged files", () => {
        it("skips a malformed snapshot instead of throwing", async () => {
            const dir = join(root, "damaged");
            const store = new WorkStore(dir);
            const good = record("subagent:p:good");
            await store.createIfAbsent(good);
            const badId = workIdForSource("subagent:p:bad");
            mkdirSync(join(dir, badId), { recursive: true });
            writeFileSync(join(dir, badId, "work.json"), "{ not json");
            const listed = await store.list();
            assert.deepEqual(
                listed.map((w) => w.workId),
                [good.workId],
            );
        });

        it("ignores a snapshot from a future schema rather than guessing", async () => {
            const dir = join(root, "schema");
            const store = new WorkStore(dir);
            const rec = record("subagent:p:future");
            mkdirSync(join(dir, rec.workId), { recursive: true });
            writeFileSync(
                join(dir, rec.workId, "work.json"),
                JSON.stringify({ ...rec, schemaVersion: 99 }),
            );
            assert.equal(await store.get(rec.workId), undefined);
        });

        it("ignores a snapshot whose workId does not match its directory", async () => {
            const dir = join(root, "mismatch");
            const store = new WorkStore(dir);
            const a = record("subagent:p:a");
            const b = record("subagent:p:b");
            mkdirSync(join(dir, a.workId), { recursive: true });
            writeFileSync(join(dir, a.workId, "work.json"), JSON.stringify(b));
            assert.equal(await store.get(a.workId), undefined);
        });
    });

    it("delete removes the whole Work including its results", async () => {
        const store = new WorkStore(join(root, "delete"));
        const rec = record("subagent:p:del");
        await store.createIfAbsent(rec);
        await store.writeResult({ workId: rec.workId, attemptId: "a", text: "x", now: 1 });
        await store.delete(rec.workId);
        assert.equal(await store.get(rec.workId), undefined);
        assert.deepEqual(await store.list(), []);
    });
});
