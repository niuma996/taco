import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { CheckpointManager } from "../../src/checkpoints/manager.ts";
import { CheckpointStore } from "../../src/checkpoints/store.ts";

describe("CheckpointManager", () => {
    let home: string;
    let workspace: string;
    let manager: CheckpointManager;
    let realStore: CheckpointStore;

    beforeEach(() => {
        const base = mkdtempSync(join(tmpdir(), "taco-cp-mgr-"));
        home = join(base, "home");
        workspace = join(base, "ws");
        mkdirSync(home, { recursive: true });
        mkdirSync(workspace, { recursive: true });
        realStore = new CheckpointStore(workspace, { home });
        manager = new CheckpointManager({ store: realStore, sessionId: "session-1" });
    });

    afterEach(() => {
        rmSync(home, { recursive: true, force: true });
        rmSync(workspace, { recursive: true, force: true });
    });

    const file = (name: string) => join(workspace, name);

    it("captures pre-write content on first sight", async () => {
        const f = file("a.ts");
        writeFileSync(f, "original");
        await manager.captureBeforeWrite(f);
        writeFileSync(f, "new");

        const list = await realStore.list();
        assert.equal(list.length, 1);
        await realStore.restore(list[0].id);
        assert.equal(readFileSync(f, "utf8"), "original");
    });

    it("does not re-capture a path already captured this turn", async () => {
        const f = file("a.ts");
        writeFileSync(f, "v1");
        await manager.captureBeforeWrite(f);
        writeFileSync(f, "v2");
        await manager.captureBeforeWrite(f); // same turn, same path
        writeFileSync(f, "v3");

        const list = await realStore.list();
        assert.equal(list.length, 1, "second capture in the same turn is a no-op");

        await realStore.restore(list[0].id);
        assert.equal(readFileSync(f, "utf8"), "v1");
    });

    it("opens a fresh checkpoint on the next turn", async () => {
        const f = file("a.ts");
        writeFileSync(f, "t1");
        await manager.captureBeforeWrite(f);

        manager.endTurn();

        writeFileSync(f, "t2");
        await manager.captureBeforeWrite(f);

        const list = await realStore.list();
        assert.equal(list.length, 2);
        // list() is newest-first
        assert.equal(list[0].label, "turn 2");
        assert.equal(list[1].label, "turn 1");
    });

    it("retries capture when the snapshot itself fails", async () => {
        const f = file("a.ts");
        writeFileSync(f, "x");
        let calls = 0;
        const failingStore: CheckpointStore = {
            create: async () => {
                calls++;
                throw new Error("disk full");
            },
            list: () => Promise.resolve([]),
            get: () => Promise.resolve(undefined),
            restore: () => Promise.resolve({ restored: [], deleted: [], failed: [] }),
        } as unknown as CheckpointStore;

        const local = new CheckpointManager({ store: failingStore, sessionId: "s" });
        // First call tries MAX_CAPTURE_ATTEMPTS times then parks the path.
        const first = await local.captureBeforeWrite(f);
        // Second call on the same path returns the cached failure — store is
        // not hit again, so the gate sees a stable, no-spam error.
        const second = await local.captureBeforeWrite(f);
        assert.equal(first.ok, false);
        assert.equal(second.ok, false);
        assert.equal(calls, 2, "first attempt hits the store up to the retry cap");
    });

    it("snapshot-protects the current state before a restore", async () => {
        const f = file("a.ts");
        writeFileSync(f, "original");
        await manager.captureBeforeWrite(f);
        writeFileSync(f, "post-turn-1");
        const list = await realStore.list();
        assert.equal(list.length, 1);

        const result = await manager.restore(list[0].id);
        assert.ok(result.protection, "restore must create a pre-restore snapshot");
        assert.equal(readFileSync(f, "utf8"), "original");

        const after = await realStore.list();
        assert.equal(after.length, 2);
        assert.ok(after.some((c) => c.label.startsWith("pre-restore")));
    });

    // A restore can land mid-turn (the user clicks Restore while the turn is
    // still running), so it must not advance turnIndex — the rest of the turn
    // still belongs to the same turn and must be labelled as such.
    it("keeps the turn label stable across a mid-turn restore", async () => {
        const a = file("a.ts");
        const b = file("b.ts");
        writeFileSync(a, "a1");
        await manager.captureBeforeWrite(a);

        const list = await realStore.list();
        await manager.restore(list[0].id);

        writeFileSync(b, "b1");
        await manager.captureBeforeWrite(b);

        const after = await realStore.list();
        const labels = after.map((c) => c.label);
        assert.ok(
            labels.every((l) => l === "turn 1" || l.startsWith("pre-restore")),
            `mid-turn restore must not advance the turn counter, got ${JSON.stringify(labels)}`,
        );
    });

    // Regression for 451b32b: restore() must reset per-turn parking state so
    // a later write to a previously-failed path retries instead of falsely
    // returning the cached failure.
    it("re-captures after restore even if earlier capture had failed", async () => {
        const f = file("a.ts");
        // Seed realStore with one checkpoint that the test can restore.
        writeFileSync(f, "v0");
        const seed = await realStore.create({
            sessionId: "s",
            label: "seed",
            paths: [f],
        });
        writeFileSync(f, "v1");

        let restored = false;
        const flaky: CheckpointStore = {
            create: async (args: Parameters<CheckpointStore["create"]>[0]) => {
                // Fail every create until restore has been called; then forward
                // so the post-restore capture succeeds and a protection snapshot
                // can be taken during restore().
                if (!restored) throw new Error("transient");
                return realStore.create(args);
            },
            list: () => realStore.list(),
            get: (id: string) => realStore.get(id),
            restore: (id: string) => realStore.restore(id),
        } as unknown as CheckpointStore;

        const local = new CheckpointManager({ store: flaky, sessionId: "s" });
        const first = await local.captureBeforeWrite(f);
        assert.equal(first.ok, false, "first attempt fails and parks the path");

        // Restore creates a protection snapshot via the same flaky stub —
        // since protection captures go through `store.create` too, we flip the
        // flag first so they forward to realStore. The protection snapshot's
        // content is the current on-disk state ("v1"), taken before the restore
        // rewrites the file back to "v0".
        restored = true;
        const result = await local.restore(seed?.id ?? "");
        assert.ok(result.protection, "restore must create a protection snapshot");

        // After restore the path's parking is cleared; a second write must
        // hit the store again rather than returning the cached failure.
        const second = await local.captureBeforeWrite(f);
        assert.equal(second.ok, true);
    });
});
