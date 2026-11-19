import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { LocalMemoryStore } from "../../src/memory/local/store.ts";
import { buildTopicFile } from "../../src/memory/local/topicCodec.ts";
import { importWorktreeMemory } from "../../src/memory/local/worktreeImport.ts";
import { memoryProjectDir } from "../../src/workspace/storagePaths.ts";
import { useTempTacoHome } from "../_helpers/tempTacoHome.ts";

const home = useTempTacoHome("worktree-import");
const legacy =
    "---\r\nname: A # literal\r\ndescription: 'quoted'\r\ntype: project\r\n---\r\n\r\nExact legacy body.  \r\n";
const versioned = buildTopicFile({
    id: "versioned",
    name: "Versioned",
    description: "Project context",
    type: "project",
    content: "Exact versioned body.",
    createdAt: "2026-11-20T00:00:00.000Z",
});

async function fixture(name: string) {
    const identity = join(home, name, "tree");
    const source = memoryProjectDir(identity);
    await mkdir(source, { recursive: true });
    const changes: boolean[] = [];
    const store = new LocalMemoryStore((global) => changes.push(global));
    store.initialize(join(home, name, "main"));
    return { identity, source, store, destination: store.topicDir, changes };
}

test("imports raw legacy and versioned topics once, preserving source and unknown files", async () => {
    const f = await fixture("raw");
    await writeFile(join(f.source, "user_role.md"), legacy);
    await writeFile(join(f.source, "versioned.md"), versioned);
    await writeFile(join(f.source, "dream-state.json"), "{derived}");
    await writeFile(join(f.source, "unknown.bin"), "unknown");
    assert.deepEqual(f.store.listTopics(), []);
    await f.store.importWorkspaceMemory(f.identity);
    assert.equal(await readFile(join(f.destination, "user_role.md"), "utf8"), legacy);
    assert.equal(await readFile(join(f.destination, "versioned.md"), "utf8"), versioned);
    assert.equal(f.store.listTopics().length, 2);
    assert.deepEqual(f.changes, [false]);
    assert.equal(await readFile(join(f.source, "user_role.md"), "utf8"), legacy);
    assert.equal(await readFile(join(f.source, "unknown.bin"), "utf8"), "unknown");
    assert.ok(!(await readdir(f.destination)).includes("dream-state.json"));
    assert.ok(!(await readdir(f.destination)).includes("unknown.bin"));
    await rm(join(f.destination, "user_role.md"));
    const reopened = new LocalMemoryStore(() => f.changes.push(false));
    reopened.initialize(join(home, "raw", "main"));
    await reopened.importWorkspaceMemory(f.identity);
    await assert.rejects(readFile(join(f.destination, "user_role.md")), { code: "ENOENT" });
    assert.deepEqual(f.changes, [false]);
});

test("keeps primary topics and uses a stable bounded collision id across retries", async () => {
    const f = await fixture("conflicts");
    const stem = `user_${"x".repeat(59)}`;
    await writeFile(join(f.source, `${stem}.md`), legacy);
    await writeFile(join(f.destination, `${stem}.md`), versioned);
    // The later archive cannot be published until the destination is repaired.
    await mkdir(join(f.source, "archive"));
    await writeFile(join(f.source, "archive", "later.md"), legacy);
    await writeFile(join(f.destination, "archive"), "keep this obstruction");
    await assert.rejects(f.store.importWorkspaceMemory(f.identity));
    const imported = (await readdir(f.destination)).filter(
        (file) => file.endsWith(".md") && file !== `${stem}.md`,
    );
    assert.equal(imported.length, 1);
    const id = imported[0].slice(0, -3);
    assert.ok(id.length <= 64);
    assert.match(id, /^[a-z0-9][a-z0-9_-]*$/);
    assert.equal(await readFile(join(f.destination, imported[0]), "utf8"), legacy);
    assert.equal(await readFile(join(f.destination, `${stem}.md`), "utf8"), versioned);
    assert.deepEqual(f.changes, []);
    await rm(join(f.destination, "archive"));
    await f.store.importWorkspaceMemory(f.identity);
    assert.deepEqual(
        (await readdir(f.destination)).filter((file) => file.endsWith(".md")).sort(),
        [...imported, `${stem}.md`].sort(),
    );
    assert.equal(await readFile(join(f.destination, "archive", "later.md"), "utf8"), legacy);
    assert.deepEqual(f.changes, [false]);
    await f.store.importWorkspaceMemory(f.identity);
    assert.deepEqual(f.changes, [false]);
});

test("copies recursive archives without injecting them or migrating derived state", async () => {
    const f = await fixture("archives");
    await mkdir(join(f.source, "archive", "history", "older"), { recursive: true });
    await writeFile(join(f.source, "archive", "old_topic.md"), legacy);
    await writeFile(join(f.source, "archive", "history", "older", "old_topic.2026.md"), versioned);
    await writeFile(join(f.source, "archive", "history", "derived.json"), "{}");
    await f.store.importWorkspaceMemory(f.identity);
    assert.equal(await readFile(join(f.destination, "archive", "old_topic.md"), "utf8"), legacy);
    assert.equal(
        await readFile(
            join(f.destination, "archive", "history", "older", "old_topic.2026.md"),
            "utf8",
        ),
        versioned,
    );
    assert.deepEqual(f.store.listTopics(), []);
    assert.equal(f.store.listArchivedTopics().length, 1);
    assert.deepEqual(await readdir(join(f.destination, "archive", "history")), ["older"]);
    assert.equal(await readFile(join(f.source, "archive", "old_topic.md"), "utf8"), legacy);
    assert.deepEqual(f.changes, [false]);
});

test("reuses an imported collision after primary deletion during an interrupted import", async () => {
    const f = await fixture("retry-deleted-primary");
    await writeFile(join(f.source, "user_role.md"), legacy);
    await writeFile(join(f.destination, "user_role.md"), versioned);
    await mkdir(join(f.source, "archive"));
    await writeFile(join(f.source, "archive", "later.md"), legacy);
    await writeFile(join(f.destination, "archive"), "blocked");
    await assert.rejects(f.store.importWorkspaceMemory(f.identity));
    const imported = (await readdir(f.destination)).filter(
        (file) => file.endsWith(".md") && file !== "user_role.md",
    );
    assert.equal(imported.length, 1);
    await rm(join(f.destination, "user_role.md"));
    await rm(join(f.destination, "archive"));
    await f.store.importWorkspaceMemory(f.identity);
    assert.deepEqual(
        (await readdir(f.destination)).filter((file) => file.endsWith(".md")),
        imported,
    );
    const id = imported[0].slice(0, -3);
    assert.ok(id.includes("_"));
    await f.store.updateTopic(id, "Updated imported topic");
    assert.equal(f.store.getTopic(id)?.content, "Updated imported topic");
});

test("rejects symlinked storage ancestors before publishing any file", {
    skip: process.platform === "win32",
}, async () => {
    for (const level of ["memory", "projects", "destination"]) {
        const f = await fixture(`ancestor-${level}`);
        await writeFile(join(f.source, "user_role.md"), legacy);
        const path =
            level === "memory"
                ? join(home, "memory")
                : level === "projects"
                  ? join(home, "memory", "projects")
                  : f.destination;
        const moved = `${path}-saved`;
        await rename(path, moved);
        await symlink(moved, path, "dir");
        try {
            await assert.rejects(f.store.importWorkspaceMemory(f.identity), /Unsafe/);
            assert.deepEqual(await readdir(f.destination), []);
        } finally {
            await rm(path);
            await rename(moved, path);
        }
    }
});

test("exclusive publication tolerates identical competing imports without losing bytes", async () => {
    const f = await fixture("exclusive");
    await writeFile(join(f.source, "user_role.md"), legacy);
    await Promise.all(
        Array.from({ length: 4 }, () => importWorktreeMemory(f.source, f.destination)),
    );
    assert.equal(await readFile(join(f.destination, "user_role.md"), "utf8"), legacy);
    assert.equal(await readFile(join(f.source, "user_role.md"), "utf8"), legacy);
    assert.equal((await readdir(f.destination)).filter((file) => file.endsWith(".tmp")).length, 0);
});

test("never overwrites an occupied stable collision path and resumes after repair", async () => {
    const f = await fixture("occupied");
    await writeFile(join(f.source, "conflict.md"), legacy);
    await writeFile(join(f.destination, "conflict.md"), versioned);
    await mkdir(join(f.source, "archive"));
    await writeFile(join(f.source, "archive", "conflict.md"), legacy);
    await mkdir(join(f.destination, "archive"));
    await writeFile(join(f.destination, "archive", "conflict.md"), versioned);
    await writeFile(join(f.source, "archive", "last.md"), versioned);
    await mkdir(join(f.destination, "archive", "last.md"));
    await assert.rejects(f.store.importWorkspaceMemory(f.identity));
    const imported = (await readdir(f.destination)).find(
        (file) => file.endsWith(".md") && file !== "conflict.md",
    );
    assert.ok(imported);
    await writeFile(join(f.destination, imported), "unrelated destination content");
    await assert.rejects(f.store.importWorkspaceMemory(f.identity), /occupied/);
    assert.equal(
        await readFile(join(f.destination, imported), "utf8"),
        "unrelated destination content",
    );
    assert.equal(await readFile(join(f.destination, "conflict.md"), "utf8"), versioned);
    await writeFile(join(f.destination, imported), legacy);
    await rm(join(f.destination, "archive", "last.md"), { recursive: true });
    await f.store.importWorkspaceMemory(f.identity);
    const archived = (await readdir(join(f.destination, "archive"))).filter(
        (name) => name !== "conflict.md" && name !== "last.md",
    );
    assert.equal(archived.length, 1);
    assert.equal(await readFile(join(f.destination, "archive", archived[0]), "utf8"), legacy);
    assert.equal(await readFile(join(f.destination, "archive", "conflict.md"), "utf8"), versioned);
    assert.deepEqual(f.changes, [false]);
});

test("deduplicates identical bytes and serializes imports with queued topic writes", async () => {
    const f = await fixture("serial");
    await writeFile(join(f.source, "same.md"), legacy);
    await writeFile(join(f.destination, "same.md"), legacy);
    await Promise.all([
        f.store.importWorkspaceMemory(f.identity),
        f.store.importWorkspaceMemory(f.identity),
    ]);
    assert.deepEqual(f.changes, []);
    assert.deepEqual(
        (await readdir(f.destination)).filter((name) => name.endsWith(".md")),
        ["same.md"],
    );
    const other = await fixture("queued");
    await writeFile(join(other.source, "user_role.md"), legacy);
    const importing = other.store.importWorkspaceMemory(other.identity);
    const appending = other.store.appendEntry({
        id: "user_role",
        name: "New",
        description: "Conflict",
        type: "project",
        content: "Must not replace imported memory",
        createdAt: "2026-11-20T00:00:00.000Z",
    });
    await importing;
    await assert.rejects(appending, /already exists/);
    assert.equal(await readFile(join(other.destination, "user_role.md"), "utf8"), legacy);
});

test("never follows source or destination symlinks", {
    skip: process.platform === "win32",
}, async () => {
    const f = await fixture("links");
    const outside = join(home, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "secret.md"), versioned);
    await symlink(join(outside, "secret.md"), join(f.source, "link.md"));
    await symlink(outside, join(f.source, "archive"), "dir");
    await f.store.importWorkspaceMemory(f.identity);
    assert.ok(!(await readdir(f.destination)).some((file) => file.endsWith(".md")));
    assert.deepEqual(f.changes, []);
    const blocked = await fixture("blocked");
    await writeFile(join(blocked.source, "topic.md"), legacy);
    await mkdir(join(blocked.source, "archive"));
    await writeFile(join(blocked.source, "archive", "old.md"), legacy);
    await symlink(outside, join(blocked.destination, "archive"), "dir");
    await assert.rejects(blocked.store.importWorkspaceMemory(blocked.identity));
    assert.deepEqual(await readdir(outside), ["secret.md"]);
    await rm(join(blocked.destination, "archive"));
    await blocked.store.importWorkspaceMemory(blocked.identity);
    assert.equal(await readFile(join(blocked.destination, "archive", "old.md"), "utf8"), legacy);
    const rootLink = await fixture("source-root");
    await rm(rootLink.source, { recursive: true });
    await symlink(outside, rootLink.source, "dir");
    await assert.rejects(rootLink.store.importWorkspaceMemory(rootLink.identity));
    assert.deepEqual(await readdir(outside), ["secret.md"]);
    const nested = await fixture("nested-links");
    await mkdir(join(nested.source, "archive", "history"), { recursive: true });
    await symlink(outside, join(nested.source, "archive", "history", "linked"), "dir");
    await symlink(join(outside, "secret.md"), join(nested.source, "archive", "secret.md"));
    await writeFile(join(nested.source, "archive", "history", "real.md"), legacy);
    await nested.store.importWorkspaceMemory(nested.identity);
    assert.deepEqual(await readdir(join(nested.destination, "archive")), ["history"]);
    assert.deepEqual(await readdir(join(nested.destination, "archive", "history")), ["real.md"]);
});

test("imports through a configured home symlink while retaining lexical storage paths", {
    skip: process.platform === "win32",
}, async () => {
    const actual = join(home, "configured-home");
    const alias = join(home, "configured-home-alias");
    await mkdir(actual);
    await symlink(actual, alias, "dir");
    const previous = process.env.TACO_HOME;
    process.env.TACO_HOME = alias;
    try {
        const f = await fixture("configured-home-import");
        await writeFile(join(f.source, "user_role.md"), legacy);
        await f.store.importWorkspaceMemory(f.identity);
        assert.ok(f.store.topicDir.startsWith(alias));
        assert.equal(await readFile(join(f.destination, "user_role.md"), "utf8"), legacy);
        await f.store.importWorkspaceMemory(join(home, "absent-old-partition"));
    } finally {
        process.env.TACO_HOME = previous;
    }
});

test("serializes imports against writes from another store for the same partition", async () => {
    const f = await fixture("shared-queue");
    await writeFile(join(f.source, "user_role.md"), legacy);
    const writer = LocalMemoryStore.openByKey(f.store.dirKey);
    const results = await Promise.allSettled([
        f.store.importWorkspaceMemory(f.identity),
        writer.appendEntry({
            id: "user_role",
            name: "New",
            description: "Conflict",
            type: "project",
            content: "Must not replace imported memory",
            createdAt: "2026-11-20T00:00:00.000Z",
        }),
    ]);
    assert.equal(results[0].status, "fulfilled");
    assert.equal(results[1].status, "rejected");
    assert.equal(await readFile(join(f.destination, "user_role.md"), "utf8"), legacy);
});
