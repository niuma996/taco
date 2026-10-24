import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MEMORY_CONTENT_MAX_CHARS } from "@taco-ai/protocol";
import {
    hashOf,
    LocalMemoryStore,
    MemoryConflictError,
    NoOpMemoryStore,
    parseTopicFrontmatter,
    readProjectTopics,
    workspaceKey,
} from "../../src/memory/index.ts";
import { MemoryExtractorImpl, parseExtractionResult } from "../../src/memory/local/extractor.ts";
import type { MemoryEntry } from "../../src/memory/types.ts";
import type { AgentMessage, Api, Model, Models, TextContent } from "../../src/runtime/pi/types.ts";
import { sidecarVersion } from "../../src/runtime/runtimeResources.ts";

describe("store", () => {
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
            const projDir = join(tmpRoot, "memory", "projects", workspaceKey("ws-test"));
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
            const topicPath = join(
                tmpRoot,
                "memory",
                "projects",
                workspaceKey("ws-test"),
                "user_role.md",
            );
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

        it("rejects a duplicate id without overwriting the existing topic", async () => {
            const s = mkStore();
            await s.appendEntry(entry({ content: "original" }));
            await assert.rejects(
                () => s.appendEntry(entry({ content: "replacement" })),
                /memory topic already exists: user_role/,
            );
            assert.equal(s.getTopic("user_role")?.content, "original");
        });

        it("allows only one of two concurrent appends with the same id", async () => {
            const s = mkStore();
            const results = await Promise.allSettled([
                s.appendEntry(entry({ content: "first" })),
                s.appendEntry(entry({ content: "second" })),
            ]);
            assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
            assert.equal(results.filter((result) => result.status === "rejected").length, 1);
            assert.equal(s.getTopic("user_role")?.content, "first");
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

        it("buildMemoryBlock prints the topic directory once and ids on each row", async () => {
            const s = mkStore();
            await s.appendEntry(entry());
            await s.appendEntry(entry({ id: "feedback", name: "Use real DB", type: "feedback" }));
            const block = s.buildMemoryBlock();
            const topicDir = join(tmpRoot, "memory", "projects", workspaceKey("ws-test"));
            assert.match(block, /Workspace memory notes/);
            assert.ok(block.includes(`fetch <id>.md from ${topicDir}`));
            assert.ok(
                block.includes("- [user] User uses pnpm — Project uses pnpm not npm — user_role"),
            );
            assert.ok(block.includes("[feedback] Use real DB"));
            assert.ok(!block.includes(join(topicDir, "user_role.md")));
        });

        it("buildMemoryBlock sorts replaced topics by updatedAt", async () => {
            const s = mkStore();
            await s.appendEntry(
                entry({ id: "older", name: "Older", createdAt: "2026-01-01T00:00:00.000Z" }),
            );
            await s.appendEntry(
                entry({ id: "newer", name: "Newer", createdAt: "2026-06-01T00:00:00.000Z" }),
            );
            await s.updateTopic("older", "recently replaced");
            const block = s.buildMemoryBlock();
            assert.ok(block.indexOf("— older") < block.indexOf("— newer"));
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
            assert.match(block, /5 additional topics not listed/);
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

        it("updateTopic with expectedContent rejects when the content has moved on", async () => {
            const store = mkStore();
            await store.appendEntry(entry({ content: "v1" }));
            await store.updateTopic("user_role", "v2");

            await assert.rejects(
                () => store.updateTopic("user_role", "stale rewrite", { expectedContent: "v1" }),
                /memory topic changed since it was read: user_role/,
            );
            assert.equal(store.getTopic("user_role")?.content, "v2");

            await store.updateTopic("user_role", "v3", { expectedContent: "v2" });
            assert.equal(store.getTopic("user_role")?.content, "v3");
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
                join(tmpRoot, "memory", "projects", workspaceKey("ws-test"), "user_role.md"),
                "utf8",
            );
            assert.match(fileRaw2, new RegExp(`createdAt: ${originalCreatedAt}`));
            assert.match(fileRaw2, /updatedAt:/);
            assert.match(fileRaw2, /\n---\n\nnew body content$/);
        });

        it("updateTopic frontmatter omits updatedAt line when entry.updatedAt undefined (backward compat)", () => {
            // Write a legacy-format file (no updatedAt line) and verify
            // readProjectTopics parses it correctly with updatedAt: undefined.
            const projDir = join(tmpRoot, "memory", "projects", workspaceKey("ws-test"));
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
});

describe("extractor", () => {
    const createdAt = "2026-07-26T00:00:00.000Z";
    const ws = "ws-1";

    const addedEntries = (actions: ReturnType<typeof parseExtractionResult>): MemoryEntry[] =>
        actions.flatMap((action) => (action.action === "add" ? [action.entry] : []));

    const existingTopic = (overrides: Partial<MemoryEntry> = {}): MemoryEntry => ({
        id: "user-language",
        name: "User language",
        description: "User prefers Chinese replies",
        type: "user",
        content: "Reply in Chinese.",
        createdAt,
        workspaceId: ws,
        ...overrides,
    });

    describe("parseExtractionResult", () => {
        it("parses add and update actions", () => {
            const raw = JSON.stringify([
                {
                    action: "add",
                    id: "user-role",
                    name: "User role",
                    type: "user",
                    content: "admin",
                },
                { action: "update", id: "project-init", content: "Updated project state" },
            ]);
            const out = parseExtractionResult(raw, createdAt, ws);
            assert.equal(out.length, 2);
            assert.equal(out[0]?.action, "add");
            assert.deepEqual(out[1], {
                action: "update",
                id: "project-init",
                content: "Updated project state",
            });
        });

        it("strips fences and ignores surrounding prose", () => {
            const fenced = parseExtractionResult(
                '```json\n[{"action":"add","name":"x","type":"user"}]\n```',
                createdAt,
                ws,
            );
            const prose = parseExtractionResult(
                'Result:\n[{"action":"add","name":"x","type":"user"}]\nDone.',
                createdAt,
                ws,
            );
            assert.equal(addedEntries(fenced)[0]?.name, "x");
            assert.equal(addedEntries(prose)[0]?.name, "x");
        });

        it("returns [] on non-JSON", () => {
            assert.deepEqual(parseExtractionResult("just text", createdAt, ws), []);
            assert.deepEqual(parseExtractionResult("{not an array}", createdAt, ws), []);
        });

        it("drops actions with missing or invalid required fields", () => {
            const raw = JSON.stringify([
                { action: "add", name: "ok", type: "user" },
                { name: "missing-action", type: "user" },
                { action: "add", name: "no-type" },
                { action: "add", type: "user" },
                { action: "add", name: "bad", type: "fact" },
                { action: "update", id: "x" },
                { action: "update", content: "missing id" },
                { action: "remove", id: "x" },
                {},
            ]);
            const out = parseExtractionResult(raw, createdAt, ws);
            assert.deepEqual(
                addedEntries(out).map((entry) => entry.name),
                ["ok"],
            );
        });

        it("normalises new ids to the handler's kebab-case rule", () => {
            const raw = JSON.stringify([
                { action: "add", id: "User Role @#$", name: "n", type: "user" },
            ]);
            const out = parseExtractionResult(raw, createdAt, ws);
            assert.equal(addedEntries(out)[0]?.id, "user-role-");
        });

        it("tolerates non-string fields without dropping the rest of the batch", () => {
            const raw = JSON.stringify([
                { action: "add", id: 42, name: "Numeric id", type: "user", content: "a" },
                { action: "add", id: { nested: true }, name: "Object id", type: "user" },
                { action: "add", id: "ok-id", name: "Fine", type: "user", content: 7 },
                { action: "add", id: "bad-name", name: 5, type: "user" },
                { action: "update", id: 9, content: "numeric update id" },
                { action: "update", id: "x", content: ["not", "a", "string"] },
                null,
                "not an object",
            ]);
            let out: ReturnType<typeof parseExtractionResult> = [];
            assert.doesNotThrow(() => {
                out = parseExtractionResult(raw, createdAt, ws);
            });
            const ids = addedEntries(out).map((entry) => entry.id);
            assert.ok(ids.includes("42"));
            assert.ok(ids.includes("ok-id"));
            assert.ok(!ids.includes("bad-name"));
            assert.equal(addedEntries(out).find((e) => e.id === "ok-id")?.content, "7");
            assert.equal(out.filter((action) => action.action === "update").length, 0);
        });

        it("synthesises distinct ids when add omits them", () => {
            const raw = JSON.stringify([
                { action: "add", name: "first", type: "user" },
                { action: "add", name: "second", type: "user" },
            ]);
            const entries = addedEntries(parseExtractionResult(raw, createdAt, ws));
            assert.ok(entries[0]?.id.startsWith("mem-"));
            assert.ok(entries[1]?.id.startsWith("mem-"));
            assert.notEqual(entries[0]?.id, entries[1]?.id);
        });

        it("truncates fields to declared limits", () => {
            const raw = JSON.stringify([
                {
                    action: "add",
                    name: "x".repeat(200),
                    description: "y".repeat(300),
                    content: "z".repeat(MEMORY_CONTENT_MAX_CHARS * 2),
                    type: "user",
                },
                { action: "update", id: "x", content: "z".repeat(MEMORY_CONTENT_MAX_CHARS * 2) },
            ]);
            const out = parseExtractionResult(raw, createdAt, ws);
            const entry = addedEntries(out)[0];
            assert.equal(entry?.name.length, 60);
            assert.equal(entry?.description.length, 120);
            assert.equal(entry?.content.length, MEMORY_CONTENT_MAX_CHARS);
            assert.equal(
                out[1]?.action === "update" && out[1].content.length,
                MEMORY_CONTENT_MAX_CHARS,
            );
        });

        it("defaults add description and content to name when missing", () => {
            const raw = JSON.stringify([
                { action: "add", id: "x", name: "fallback", type: "user" },
            ]);
            const entry = addedEntries(parseExtractionResult(raw, createdAt, ws))[0];
            assert.equal(entry?.description, "fallback");
            assert.equal(entry?.content, "fallback");
            assert.equal(entry?.createdAt, createdAt);
            assert.equal(entry?.workspaceId, ws);
        });
    });

    describe("MemoryExtractorImpl", () => {
        interface ExtractionContext {
            systemPrompt: string;
            messages: Array<{ content: string }>;
        }

        function makeExtractor(response: unknown, existing: MemoryEntry[] = []) {
            const calls: {
                context?: ExtractionContext;
                options?: { headers?: Record<string, string> };
            } = {};
            const appended: MemoryEntry[] = [];
            const updates: Array<{ id: string; content: string }> = [];
            const fakeModel = { provider: "test", id: "m" } as unknown as Model<Api>;
            const fakeModels = {
                completeSimple: async (
                    _model: Model<Api>,
                    context: ExtractionContext,
                    options?: { headers?: Record<string, string> },
                ) => {
                    calls.context = context;
                    calls.options = options;
                    return {
                        role: "assistant",
                        content: [
                            { type: "text", text: JSON.stringify(response) } satisfies TextContent,
                        ],
                    };
                },
            } as unknown as Models;
            const store = {
                listTopics: () => existing,
                appendEntry: async (entry: MemoryEntry) => {
                    appended.push(entry);
                },
                updateTopic: async (id: string, content: string) => {
                    updates.push({ id, content });
                    return { ...existingTopic({ id }), content };
                },
            };
            return {
                extractor: new MemoryExtractorImpl(fakeModels, fakeModel, store, ws),
                calls,
                appended,
                updates,
            };
        }

        const conversation = [
            {
                role: "user",
                content: "this is a memory-worthy conversation ".repeat(20),
            } as unknown as AgentMessage,
        ];

        it("sends the existing index and taco headers with the extraction call", async () => {
            const { extractor, calls } = makeExtractor([], [existingTopic()]);
            await extractor.onRunEnd(conversation);

            const version = sidecarVersion();
            assert.equal(calls.options?.headers?.["user-agent"], `taco/${version}`);
            assert.equal(calls.options?.headers?.["x-taco-sidecar-version"], version);
            assert.ok(calls.context?.messages[0]?.content.includes('"id":"user-language"'));
            assert.ok(calls.context?.messages[0]?.content.includes("User prefers Chinese replies"));
        });

        it("routes updates to existing ids and adds only genuinely new ids", async () => {
            const { extractor, appended, updates } = makeExtractor(
                [
                    { action: "update", id: "user-language", content: "Reply in concise Chinese." },
                    { action: "add", id: "user-language", name: "Duplicate", type: "user" },
                    {
                        action: "add",
                        id: "new-pref",
                        name: "New",
                        type: "feedback",
                        content: "New fact",
                    },
                    { action: "update", id: "unknown", content: "Must not be created" },
                ],
                [existingTopic()],
            );
            await extractor.onRunEnd(conversation);

            assert.deepEqual(updates, [
                { id: "user-language", content: "Reply in concise Chinese." },
            ]);
            assert.deepEqual(
                appended.map((entry) => entry.id),
                ["new-pref"],
            );
        });

        it("keeps only the first add for a new id within one result", async () => {
            const { extractor, appended } = makeExtractor([
                { action: "add", id: "same-id", name: "First", type: "user", content: "first" },
                { action: "add", id: "same-id", name: "Second", type: "user", content: "second" },
            ]);
            await extractor.onRunEnd(conversation);
            assert.deepEqual(
                appended.map((entry) => entry.content),
                ["first"],
            );
        });

        it("does not fork a legacy underscore id into a kebab-case duplicate", async () => {
            const { extractor, appended } = makeExtractor(
                [{ action: "add", id: "user_language", name: "Duplicate", type: "user" }],
                [existingTopic({ id: "user_language" })],
            );
            await extractor.onRunEnd(conversation);
            assert.equal(appended.length, 0);
        });

        it("shows existing content to the model so updates can keep its details", async () => {
            const { extractor, calls } = makeExtractor(
                [],
                [existingTopic({ content: "Reply in Chinese; keep code identifiers in English." })],
            );
            await extractor.onRunEnd(conversation);
            assert.ok(
                calls.context?.messages[0]?.content.includes(
                    "Reply in Chinese; keep code identifiers in English.",
                ),
            );
        });

        it("passes the snapshot content as expectedContent on update", async () => {
            const seen: Array<{ expectedContent?: string }> = [];
            const fakeModels = {
                completeSimple: async () => ({
                    role: "assistant",
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify([
                                { action: "update", id: "user-language", content: "new" },
                            ]),
                        } satisfies TextContent,
                    ],
                }),
            } as unknown as Models;
            const extractor = new MemoryExtractorImpl(
                fakeModels,
                {} as Model<Api>,
                {
                    listTopics: () => [existingTopic({ content: "snapshot" })],
                    appendEntry: async () => undefined,
                    updateTopic: async (id, content, options) => {
                        seen.push(options ?? {});
                        return { ...existingTopic({ id }), content };
                    },
                },
                ws,
            );
            await extractor.onRunEnd(conversation);
            assert.deepEqual(seen, [{ expectedContent: "snapshot" }]);
        });

        it("serialises runs so a slow earlier extraction cannot overwrite a later one", async () => {
            // Real store: the bug only shows when snapshots and writes hit disk.
            const prevTacoHome = process.env.TACO_HOME;
            const root = mkdtempSync(join(tmpdir(), "taco-mem-race-"));
            process.env.TACO_HOME = root;
            try {
                const store = new LocalMemoryStore();
                store.initialize(ws);
                await store.appendEntry(existingTopic({ content: "v1" }));

                // Run A's model call is held open until run B has fully finished.
                let releaseA: (() => void) | undefined;
                const aGate = new Promise<void>((resolve) => {
                    releaseA = resolve;
                });
                let call = 0;
                const snapshots: string[] = [];
                const fakeModels = {
                    completeSimple: async (_m: Model<Api>, context: ExtractionContext) => {
                        call++;
                        const mine = call;
                        snapshots.push(context.messages[0]?.content ?? "");
                        if (mine === 1) await aGate;
                        const content = mine === 1 ? "A rewrite of v1" : "B rewrite";
                        return {
                            role: "assistant",
                            content: [
                                {
                                    type: "text",
                                    text: JSON.stringify([
                                        { action: "update", id: "user-language", content },
                                    ]),
                                } satisfies TextContent,
                            ],
                        };
                    },
                } as unknown as Models;
                const extractor = new MemoryExtractorImpl(fakeModels, {} as Model<Api>, store, ws);

                const runA = extractor.onRunEnd(conversation);
                const runB = extractor.onRunEnd(conversation);
                // Give B every chance to overtake A if runs were not serialised.
                await new Promise((resolve) => setTimeout(resolve, 20));
                assert.equal(call, 1, "run B must not start before run A finishes");
                releaseA?.();
                await Promise.all([runA, runB]);

                assert.equal(call, 2);
                // B snapshotted after A's write, so its update applies on top of A.
                assert.ok(snapshots[1]?.includes("A rewrite of v1"));
                assert.equal(store.getTopic("user-language")?.content, "B rewrite");
            } finally {
                if (prevTacoHome === undefined) Reflect.deleteProperty(process.env, "TACO_HOME");
                else process.env.TACO_HOME = prevTacoHome;
                rmSync(root, { recursive: true, force: true });
            }
        });

        it("keeps the newer write when an update's snapshot went stale", async () => {
            const prevTacoHome = process.env.TACO_HOME;
            const root = mkdtempSync(join(tmpdir(), "taco-mem-cas-"));
            process.env.TACO_HOME = root;
            try {
                const store = new LocalMemoryStore();
                store.initialize(ws);
                await store.appendEntry(existingTopic({ content: "v1" }));
                const fakeModels = {
                    completeSimple: async () => {
                        // A MemoryPane / memory-tool edit lands during the LLM call.
                        await store.updateTopic("user-language", "edited by user");
                        return {
                            role: "assistant",
                            content: [
                                {
                                    type: "text",
                                    text: JSON.stringify([
                                        {
                                            action: "update",
                                            id: "user-language",
                                            content: "rewrite of v1",
                                        },
                                    ]),
                                } satisfies TextContent,
                            ],
                        };
                    },
                } as unknown as Models;
                const extractor = new MemoryExtractorImpl(fakeModels, {} as Model<Api>, store, ws);
                await extractor.onRunEnd(conversation);
                assert.equal(store.getTopic("user-language")?.content, "edited by user");
            } finally {
                if (prevTacoHome === undefined) Reflect.deleteProperty(process.env, "TACO_HOME");
                else process.env.TACO_HOME = prevTacoHome;
                rmSync(root, { recursive: true, force: true });
            }
        });

        it("a failed extraction does not block later runs", async () => {
            let call = 0;
            const appended: MemoryEntry[] = [];
            const fakeModels = {
                completeSimple: async () => {
                    call++;
                    if (call === 1) throw new Error("provider down");
                    return {
                        role: "assistant",
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify([
                                    { action: "add", id: "later", name: "Later", type: "user" },
                                ]),
                            } satisfies TextContent,
                        ],
                    };
                },
            } as unknown as Models;
            const extractor = new MemoryExtractorImpl(
                fakeModels,
                {} as Model<Api>,
                {
                    listTopics: () => [],
                    appendEntry: async (entry) => {
                        appended.push(entry);
                    },
                    updateTopic: async () => existingTopic(),
                },
                ws,
            );
            await extractor.onRunEnd(conversation);
            await extractor.onRunEnd(conversation);
            assert.deepEqual(
                appended.map((entry) => entry.id),
                ["later"],
            );
        });

        it("does not invoke the LLM below the token gate", async () => {
            let called = false;
            const fakeModels = {
                completeSimple: async () => {
                    called = true;
                    return undefined;
                },
            } as unknown as Models;
            const extractor = new MemoryExtractorImpl(
                fakeModels,
                {} as Model<Api>,
                {
                    listTopics: () => [],
                    appendEntry: async () => undefined,
                    updateTopic: async () => existingTopic(),
                },
                ws,
            );
            await extractor.onRunEnd([{ role: "user", content: "hi" } as AgentMessage]);
            assert.equal(called, false);
        });
    });
});
