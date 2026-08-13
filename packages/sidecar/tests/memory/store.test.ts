/**
 * LocalMemoryStore — file-backed store, parseTopicFrontmatter, readProjectTopics.
 * Each test gets its own TACO_HOME (per-test mkdtempSync dir) for isolation.
 * Covers: initialize, appendEntry, readMemory, buildMemoryBlock, concurrent
 * appendEntry (serialised queue), truncation, optimistic concurrency (baseHash),
 * deleteTopic, NoOpMemoryStore.
 */

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
    hashOf,
    LocalMemoryStore,
    MemoryConflictError,
    NoOpMemoryStore,
    parseTopicFrontmatter,
    readProjectTopics,
} from "../../src/memory/index.ts";
import type { MemoryEntry } from "../../src/memory/types.ts";

let tmpRoot: string;
let prevTacoHome: string | undefined;

beforeEach(() => {
    prevTacoHome = process.env.TACO_HOME;
    tmpRoot = mkdtempSync(join(tmpdir(), "taco-mem-store-"));
    process.env.TACO_HOME = tmpRoot;
});

afterEach(() => {
    if (prevTacoHome === undefined) Reflect.deleteProperty(process.env, "TACO_HOME");
    else process.env.TACO_HOME = prevTacoHome;
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

function mkStore(): LocalMemoryStore {
    const s = new LocalMemoryStore();
    s.initialize("ws-test");
    return s;
}

const entry = (overrides: Partial<MemoryEntry> = {}): MemoryEntry => ({
    id: "user_role",
    name: "User uses pnpm",
    description: "Project uses pnpm not npm",
    type: "user",
    content: "User explicitly said pnpm.",
    createdAt: "2026-07-26T00:00:00.000Z",
    workspaceId: "ws-test",
    ...overrides,
});

describe("LocalMemoryStore.initialize", () => {
    it("creates MEMORY.md with header and project dir", () => {
        const _s = mkStore();
        const memPath = join(tmpRoot, "memory", "MEMORY.md");
        const projDir = join(tmpRoot, "memory", "projects", "ws-test");
        assert.ok(existsSync(memPath), "MEMORY.md should exist");
        assert.ok(existsSync(projDir), "project dir should exist");
        const header = readFileSync(memPath, "utf8");
        assert.equal(header, "# Memory\n\n");
    });

    it("is idempotent — second initialize is a no-op", () => {
        const s = mkStore();
        // Overwrite to verify second initialize does NOT reset the header.
        const memPath = join(tmpRoot, "memory", "MEMORY.md");
        writeFileSync(memPath, "tampered", "utf8");
        s.initialize("different-ws");
        // Header is NOT reset; the tampered content remains.
        assert.equal(readFileSync(memPath, "utf8"), "tampered");
    });
});

describe("LocalMemoryStore.appendEntry", () => {
    it("writes a topic file; MEMORY.md stays untouched", async () => {
        const s = mkStore();
        await s.appendEntry(entry());
        const topicPath = join(tmpRoot, "memory", "projects", "ws-test", "user_role.md");
        const topic = readFileSync(topicPath, "utf8");
        assert.match(topic, /^---\nname: User uses pnpm/);
        assert.match(topic, /type: user/);
        assert.match(topic, /User explicitly said pnpm\./);

        // MEMORY.md is user-managed — appendEntry must NOT touch it.
        const mem = readFileSync(join(tmpRoot, "memory", "MEMORY.md"), "utf8");
        assert.equal(mem, "# Memory\n\n");
    });

    it("appends multiple topic files, each addressable by id", async () => {
        const s = mkStore();
        await s.appendEntry(entry({ id: "a", name: "A", content: "marker-A" }));
        await s.appendEntry(entry({ id: "b", name: "B", content: "marker-B" }));
        await s.appendEntry(entry({ id: "c", name: "C", content: "marker-C" }));
        const ids = readProjectTopics("ws-test")
            .map((e) => e.id)
            .sort();
        assert.deepEqual(ids, ["a", "b", "c"]);
    });

    it("concurrent appendEntry calls do not lose entries (Promise-chain serialisation)", async () => {
        const s = mkStore();
        const N = 50;
        // Fire all appends in the same microtask — without the chain, parallel
        // topic-file writes could interleave and drop entries.
        const promises: Promise<void>[] = [];
        for (let i = 0; i < N; i++) {
            promises.push(s.appendEntry(entry({ id: `c${i}`, content: `marker-${i}` })));
        }
        await Promise.all(promises);
        const ids = readProjectTopics("ws-test").map((e) => e.id);
        for (let i = 0; i < N; i++) {
            assert.ok(ids.includes(`c${i}`), `entry ${i} must be present`);
        }
    });

    it("rejects when not initialized", async () => {
        const s = new LocalMemoryStore();
        await assert.rejects(() => s.appendEntry(entry()), /LocalMemoryStore not initialized/);
    });
});

describe("LocalMemoryStore.readMemory / buildMemoryBlock", () => {
    it("readMemory returns the header when MEMORY.md is empty", () => {
        const s = mkStore();
        const mem = s.readMemory();
        assert.equal(mem, "# Memory\n\n");
    });

    it("buildMemoryBlock returns '' when MEMORY.md has only the header and no topics", () => {
        const s = mkStore();
        assert.equal(s.buildMemoryBlock(), "");
    });

    it("buildMemoryBlock includes the user MEMORY.md note verbatim", async () => {
        const s = mkStore();
        const manual = "# Memory\n\n## My hand-written section\n\nfree text\n";
        await s.writeMemory(manual, hashOf(s.readMemory()));
        assert.ok(s.buildMemoryBlock().includes("free text"));
    });

    it("buildMemoryBlock aggregates topic summaries with file paths", async () => {
        const s = mkStore();
        await s.appendEntry(entry());
        await s.appendEntry(entry({ id: "feedback", name: "Use real DB", type: "feedback" }));
        const block = s.buildMemoryBlock();
        // Topic summary lines with type + name + path
        assert.match(block, /Workspace memory notes/);
        assert.match(block, /\[user\] User uses pnpm/);
        assert.match(block, /\[feedback\] Use real DB/);
        assert.ok(
            block.includes(join(tmpRoot, "memory", "projects", "ws-test", "user_role.md")),
            "block must include the topic file path",
        );
    });

    it("buildMemoryBlock lists newest topics first, capped at 100", async () => {
        const s = mkStore();
        for (let i = 0; i < 105; i++) {
            await s.appendEntry(
                entry({
                    id: `t${i}`,
                    name: `topic ${i}`,
                    createdAt: new Date(2026, 0, 1, 0, 0, i).toISOString(),
                }),
            );
        }
        const block = s.buildMemoryBlock();
        // Oldest 5 dropped (topic 0..4 gone), newest kept
        assert.doesNotMatch(block, /\[user\] topic 0 —/);
        assert.doesNotMatch(block, /\[user\] topic 4 —/);
        assert.match(block, /\[user\] topic 5 —/);
        assert.match(block, /\[user\] topic 104 —/);
        assert.doesNotMatch(block, /\[user\] topic 105 —/);
    });
});

describe("writeMemory (optimistic concurrency)", () => {
    it("overwrites MEMORY.md with new content when baseHash matches", async () => {
        const store = mkStore();
        const initial = store.readMemory();
        const baseHash = hashOf(initial);
        const newContent = `${initial}\n## [2026-07-29T00:00:00.000Z] user\n\nmanual edit\n`;
        await store.writeMemory(newContent, baseHash);
        assert.equal(store.readMemory(), newContent);
    });

    it("throws MemoryConflictError and does NOT modify file when baseHash is stale", async () => {
        const store = mkStore();
        const original = store.readMemory();
        // Write first so hash diverges from original
        const staleHash = hashOf(original);
        const firstWrite = `${original}\n## [...some change...]\n`;
        await store.writeMemory(firstWrite, staleHash);
        const afterFirstWrite = store.readMemory();

        // Second attempt with the same stale hash must be rejected
        const secondAttempt = `${original}\n## [...overwrite attempt...]\n`;
        await assert.rejects(
            () => store.writeMemory(secondAttempt, staleHash),
            (err: unknown) => {
                assert.ok(err instanceof MemoryConflictError);
                assert.equal((err as MemoryConflictError).currentContent, afterFirstWrite);
                return true;
            },
        );

        // File must not be polluted by the second attempt
        assert.equal(store.readMemory(), afterFirstWrite);
    });
});

describe("getTopic / updateTopic", () => {
    it("getTopic returns undefined for unknown id", () => {
        const store = mkStore();
        assert.equal(store.getTopic("does_not_exist"), undefined);
    });

    it("getTopic returns the entry after appendEntry", async () => {
        const store = mkStore();
        await store.appendEntry(entry());
        const got = store.getTopic("user_role");
        assert.ok(got);
        assert.equal(got?.name, "User uses pnpm");
        assert.equal(got?.updatedAt, undefined); // new entry has no updatedAt
    });

    it("updateTopic throws for unknown id and does not crash the chain", async () => {
        const store = mkStore();
        await assert.rejects(
            () => store.updateTopic("does_not_exist", "x"),
            /unknown memory topic/,
        );
        // chain still usable: subsequent appendEntry must still succeed
        await store.appendEntry(entry());
        assert.ok(store.getTopic("user_role"));
    });

    it("updateTopic overwrites content, sets updatedAt, preserves other fields", async () => {
        const store = mkStore();
        await store.appendEntry(entry());
        const before = store.getTopic("user_role");
        assert.ok(before);
        const originalCreatedAt = before?.createdAt;

        // wait a few ms so ISO timestamps differ (avoids updatedAt === createdAt)
        await new Promise((r) => setTimeout(r, 20));

        const result = await store.updateTopic("user_role", "new body content");
        assert.equal(result.content, "new body content");
        assert.ok(result.updatedAt);
        assert.notEqual(result.updatedAt, originalCreatedAt);

        // in-memory view is updated
        const after = store.getTopic("user_role");
        assert.ok(after);
        assert.equal(after?.content, "new body content");
        assert.equal(after?.name, "User uses pnpm"); // preserved
        assert.equal(after?.description, "Project uses pnpm not npm"); // preserved
        assert.equal(after?.type, "user"); // preserved
        assert.equal(after?.updatedAt, result.updatedAt);

        // createdAt is preserved in file content (getTopic reads mtime, not frontmatter)
        const fileRaw2 = readFileSync(
            join(tmpRoot, "memory", "projects", "ws-test", "user_role.md"),
            "utf8",
        );
        assert.match(fileRaw2, new RegExp(`createdAt: ${originalCreatedAt}`));
        assert.match(fileRaw2, /updatedAt:/);
        assert.match(fileRaw2, /\n---\n\nnew body content$/);
    });

    it("updateTopic frontmatter omits updatedAt line when entry.updatedAt undefined (backward compat)", () => {
        // Write a legacy-format file (no updatedAt line) and verify
        // readProjectTopics parses it correctly with updatedAt: undefined.
        const projDir = join(tmpRoot, "memory", "projects", "ws-test");
        mkdirSync(projDir, { recursive: true });
        writeFileSync(
            join(projDir, "old_style.md"),
            "---\nname: Old\ndescription: desc\ntype: user\n---\n\nold content\n",
        );
        const store = mkStore();
        const got = store.getTopic("old_style");
        assert.ok(got);
        assert.equal(got?.updatedAt, undefined);
    });
});

describe("concurrent updateTopic + appendEntry", () => {
    it("yields either successful update or successful append; never interleaved half-written file", async () => {
        const store = mkStore();
        await store.appendEntry(entry());

        const baseline = store.getTopic("user_role");
        assert.ok(baseline);
        const newContent = "concurrent replace content";

        const updateP = store.updateTopic("user_role", newContent);
        const appendP = store.appendEntry({
            ...entry({ id: "concurrent_topic", name: "x", description: "x" }),
            workspaceId: "ws-test",
        });

        const updateResult = await updateP.then(
            () => ({ ok: true as const }),
            (e: unknown) => ({ ok: false as const, err: e }),
        );
        await appendP;

        // updateTopic must succeed (appendEntry queued after user_role write, so it
        // does not invalidate user_role's writeChain tick).
        assert.ok(updateResult.ok);

        const final = store.getTopic("user_role");
        assert.ok(final);
        assert.equal(final?.content, newContent);
        assert.ok(final?.updatedAt); // write succeeded
    });
});

describe("deleteTopic", () => {
    it("removes an existing topic file", async () => {
        const store = mkStore();
        const e: MemoryEntry = {
            ...entry(),
            id: "to_delete",
            workspaceId: "ws-test",
        };
        await store.appendEntry(e);
        const before = readProjectTopics("ws-test");
        assert.ok(before.some((x) => x.id === "to_delete"));

        await store.deleteTopic("to_delete");

        const after = readProjectTopics("ws-test");
        assert.ok(!after.some((x) => x.id === "to_delete"));
    });

    it("throws for unknown id and does not crash the chain", async () => {
        const store = mkStore();
        await assert.rejects(() => store.deleteTopic("does_not_exist"), /unknown memory topic/);
        // Chain still usable: subsequent appendEntry must still succeed
        await store.appendEntry(entry());
        assert.ok(readProjectTopics("ws-test").some((e) => e.id === entry().id));
    });
});

describe("parseTopicFrontmatter", () => {
    it("parses a well-formed topic file", () => {
        const raw = `---
name: User role
description: User is admin
type: user
createdAt: 2026-07-26T00:00:00.000Z
---

Some content here.`;
        assert.deepEqual(parseTopicFrontmatter(raw), {
            name: "User role",
            description: "User is admin",
            type: "user",
            createdAt: "2026-07-26T00:00:00.000Z",
            updatedAt: undefined,
        });
    });

    it("returns null when frontmatter is missing", () => {
        assert.equal(parseTopicFrontmatter("no frontmatter at all"), null);
    });

    it("returns null when type is invalid", () => {
        const raw = `---
name: x
description: y
type: bogus
---

content`;
        assert.equal(parseTopicFrontmatter(raw), null);
    });
});

describe("readProjectTopics", () => {
    it("returns entries for all topic files in the project dir", async () => {
        const s = mkStore();
        await s.appendEntry(entry({ id: "alpha" }));
        await s.appendEntry(entry({ id: "beta", type: "feedback" }));
        const entries = readProjectTopics("ws-test");
        assert.equal(entries.length, 2);
        const ids = entries.map((e) => e.id).sort();
        assert.deepEqual(ids, ["alpha", "beta"]);
        const beta = entries.find((e) => e.id === "beta");
        assert.equal(beta?.type, "feedback");
        assert.match(beta?.content ?? "", /User explicitly said pnpm\./);
    });

    it("returns [] when the project dir doesn't exist", () => {
        const entries = readProjectTopics("does-not-exist");
        assert.deepEqual(entries, []);
    });
});

describe("NoOpMemoryStore", () => {
    it("is a true no-op for all methods", async () => {
        const s = new NoOpMemoryStore();
        s.initialize("anything");
        await s.appendEntry(entry());
        assert.equal(s.readMemory(), "");
        assert.equal(s.buildMemoryBlock(), "");
    });
});

describe("concurrent writeMemory + appendEntry", () => {
    it("writeMemory and appendEntry touch disjoint files (never interleave)", async () => {
        const store = mkStore();
        const baseline = store.readMemory();
        const baseHash = hashOf(baseline);
        const newMemoryContent = `${baseline}\n## [2026-07-29T00:00:00.000Z] user\n\nfrom write\n`;
        const e: MemoryEntry = {
            ...entry({ id: "concurrency_topic", name: "x", description: "x" }),
            workspaceId: "ws-test",
        };

        // Fire both without awaiting — order is non-deterministic
        const writeP = store.writeMemory(newMemoryContent, baseHash);
        const appendP = store.appendEntry(e);
        await Promise.allSettled([writeP, appendP]);

        // writeMemory may succeed or throw MemoryConflictError (appendEntry no
        // longer modifies MEMORY.md, so only a user edit can race it).
        assert.equal(store.readMemory(), newMemoryContent);
        // appendEntry's topic file exists regardless
        assert.ok(store.getTopic("concurrency_topic"));
    });
});
