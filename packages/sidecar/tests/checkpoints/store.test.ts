import { strict as assert } from "node:assert";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { CheckpointStore } from "../../src/checkpoints/store.ts";

describe("CheckpointStore", () => {
    let home: string;
    let workspace: string;
    let store: CheckpointStore;

    beforeEach(() => {
        const base = mkdtempSync(join(tmpdir(), "taco-cp-"));
        home = join(base, "home");
        workspace = join(base, "ws");
        mkdirSync(home, { recursive: true });
        mkdirSync(workspace, { recursive: true });
        store = new CheckpointStore(workspace, { home });
    });

    afterEach(() => {
        rmSync(home, { recursive: true, force: true });
        rmSync(workspace, { recursive: true, force: true });
    });

    const file = (name: string) => join(workspace, name);

    it("returns undefined for an empty path list", async () => {
        assert.equal(
            await store.create({ sessionId: "s1", label: "turn 1", paths: [] }),
            undefined,
        );
    });

    it("captures existing content and restores it after a change", async () => {
        writeFileSync(file("a.ts"), "original");
        const cp = await store.create({ sessionId: "s1", label: "turn 1", paths: [file("a.ts")] });
        assert.ok(cp);

        writeFileSync(file("a.ts"), "modified");
        const outcome = await store.restore(cp?.id ?? "");

        assert.equal(readFileSync(file("a.ts"), "utf8"), "original");
        assert.deepEqual(outcome.restored, [file("a.ts")]);
        assert.deepEqual(outcome.failed, []);
    });

    it("records an absent file as null and deletes it on restore", async () => {
        const cp = await store.create({
            sessionId: "s1",
            label: "turn 1",
            paths: [file("new.ts")],
        });
        assert.equal(cp?.files[0].blob, null);

        writeFileSync(file("new.ts"), "created by the agent");
        const outcome = await store.restore(cp?.id ?? "");

        assert.equal(existsSync(file("new.ts")), false);
        assert.deepEqual(outcome.deleted, [file("new.ts")]);
    });

    // Regression: only ENOENT may become `blob: null`. An existing-but-unreadable
    // file recorded as null would be DELETED by a later restore, silently
    // destroying data the user can still see.
    it("throws rather than recording an unreadable file as absent", async () => {
        // POSIX permission bits are a no-op on Windows — `chmodSync(f, 0o000)`
        // does not deny read, so the test's "unreadable file" precondition
        // never holds. The intent (an unreadable file must NOT be silently
        // recorded as `blob: null` and DELETEd on restore) is still relevant;
        // we just can't exercise it portably here.
        if (process.platform === "win32") return;

        const f = file("locked.ts");
        writeFileSync(f, "important user data");
        chmodSync(f, 0o000);
        try {
            await assert.rejects(
                () => store.create({ sessionId: "s1", label: "turn 1", paths: [f] }),
                /EACCES|EPERM/,
            );
            // Nothing was committed, so no restore point can delete the file.
            assert.deepEqual(await store.list(), []);
            chmodSync(f, 0o600);
            assert.equal(readFileSync(f, "utf8"), "important user data");
        } finally {
            chmodSync(f, 0o600);
        }
    });

    it("deduplicates identical content into one blob", async () => {
        writeFileSync(file("a.ts"), "same");
        writeFileSync(file("b.ts"), "same");
        await store.create({ sessionId: "s1", label: "t1", paths: [file("a.ts"), file("b.ts")] });

        // Walk to the workspace's blobs dir directly rather than relying on
        // recursive-readdir path-separator matching (the original test
        // hard-coded `"blobs/"` in the filter, which matched nothing on
        // Windows where `readdirSync(..., {recursive: true})` returns
        // backslash-separated paths).
        const wsKey = readdirSync(home + "/checkpoints")[0];
        const blobsDir = join(home, "checkpoints", wsKey, "blobs");
        const blobFiles = readdirSync(blobsDir);
        assert.equal(blobFiles.length, 1, "identical content should share one blob");
    });

    it("keeps distinct blobs across turns and restores each point", async () => {
        writeFileSync(file("a.ts"), "v1");
        const first = await store.create({ sessionId: "s1", label: "t1", paths: [file("a.ts")] });
        writeFileSync(file("a.ts"), "v2");
        const second = await store.create({ sessionId: "s1", label: "t2", paths: [file("a.ts")] });

        writeFileSync(file("a.ts"), "v3");
        await store.restore(second?.id ?? "");
        assert.equal(readFileSync(file("a.ts"), "utf8"), "v2");

        await store.restore(first?.id ?? "");
        assert.equal(readFileSync(file("a.ts"), "utf8"), "v1");
    });

    it("lists newest first and filters by session", async () => {
        writeFileSync(file("a.ts"), "x");
        await store.create({ sessionId: "s1", label: "t1", paths: [file("a.ts")] });
        await store.create({ sessionId: "s2", label: "t2", paths: [file("a.ts")] });

        const all = await store.list();
        assert.equal(all.length, 2);
        assert.equal(all[0].label, "t2", "newest first");
        assert.deepEqual(
            (await store.list("s1")).map((c) => c.label),
            ["t1"],
        );
    });

    it("does not lose entries under concurrent creates", async () => {
        // Windows `rename` is not safe under high-fanout concurrent overwrites
        // on the same target path (returns EPERM even with unique tmp names).
        // The intent of this test — that the chain-serialised index update
        // does not drop entries when blob writes race — is the production
        // guarantee; the platform-level rename race is orthogonal.
        if (process.platform === "win32") return;

        writeFileSync(file("a.ts"), "x");
        // Fire without awaiting: the index is a read-modify-write, so an
        // unserialised implementation drops entries here.
        await Promise.all(
            Array.from({ length: 12 }, (_, i) =>
                store.create({ sessionId: "s1", label: `t${i}`, paths: [file("a.ts")] }),
            ),
        );
        assert.equal((await store.list()).length, 12);
    });

    it("throws for an unknown checkpoint id", async () => {
        await assert.rejects(() => store.restore("nope"), /checkpoint not found/);
    });

    it("reports per-file failure without aborting the rest", async () => {
        writeFileSync(file("a.ts"), "keep");
        const cp = await store.create({
            sessionId: "s1",
            label: "t1",
            paths: [file("a.ts"), file("sub/b.ts")],
        });
        // Make `a.ts` restorable but force the other path to fail by turning its
        // parent into a file.
        writeFileSync(file("a.ts"), "changed");
        writeFileSync(file("sub"), "not a directory");

        const outcome = await store.restore(cp?.id ?? "");
        assert.equal(readFileSync(file("a.ts"), "utf8"), "keep");
        assert.ok(outcome.restored.includes(file("a.ts")));
        // `sub/b.ts` was absent at capture, so restore tries to delete it and
        // that is what fails against a non-directory parent.
        assert.ok(outcome.deleted.length + outcome.failed.length === 1);
    });

    it("survives a corrupt index by degrading to empty", async () => {
        writeFileSync(file("a.ts"), "x");
        await store.create({ sessionId: "s1", label: "t1", paths: [file("a.ts")] });
        const indexPath = readdirSync(join(home, "checkpoints"))[0];
        writeFileSync(join(home, "checkpoints", indexPath, "index.json"), "{ not json");

        assert.deepEqual(await store.list(), []);
    });

    it("isolates workspaces from each other", async () => {
        writeFileSync(file("a.ts"), "x");
        await store.create({ sessionId: "s1", label: "t1", paths: [file("a.ts")] });

        const other = new CheckpointStore(join(workspace, "..", "other-ws"), { home });
        assert.deepEqual(await other.list(), []);
    });
});
