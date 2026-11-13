import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, before, beforeEach, describe, it } from "node:test";
import { asSessionId, asWorkspaceId, MEMORY_CONTENT_MAX_CHARS } from "@taco-ai/protocol";
import matter from "gray-matter";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { LocalMemoryStore, parseTopicFrontmatter } from "../../src/memory/local/store.ts";
import type { MemoryEntry } from "../../src/memory/types.ts";
import * as memoryTypes from "../../src/memory/types.ts";
import { registerMemoryHandlers } from "../../src/server/handlers/memory.ts";
import { getRegisteredMethod, type MethodCtx } from "../../src/server/methodRegistry.ts";
import { createMemoryTool } from "../../src/tools/memory.ts";
import { invokeTool } from "../_helpers/invokeTool.ts";

const workspace = asWorkspaceId("/tmp/memory-contract");
const source = {
    sessionId: "session-a",
    recordedAt: "2026-01-01T00:00:00.000Z",
    via: "auto" as const,
    entryId: "entry-a",
};
const toolSource = {
    sessionId: "session-b",
    recordedAt: "2026-02-01T00:00:00.000Z",
    via: "tool" as const,
};
const entry: MemoryEntry = {
    id: "durable-theme",
    name: "Theme",
    description: "A durable theme",
    type: "feedback",
    content: "Use a clear conclusion first.",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-02-01T00:00:00.000Z",
};

describe("memory write contract", () => {
    let root: string;
    let previousHome: string | undefined;
    let store: LocalMemoryStore;
    before(() => registerMemoryHandlers());
    beforeEach(() => {
        previousHome = process.env.TACO_HOME;
        root = mkdtempSync(join(tmpdir(), "taco-memory-contract-"));
        process.env.TACO_HOME = root;
        store = new LocalMemoryStore();
        store.initialize(workspace);
    });
    afterEach(() => {
        if (previousHome === undefined) Reflect.deleteProperty(process.env, "TACO_HOME");
        else process.env.TACO_HOME = previousHome;
        rmSync(root, { recursive: true, force: true });
    });
    const topicPath = () => join(store.topicDir, `${entry.id}.md`);
    async function rpc(method: string, params: unknown): Promise<unknown> {
        const registered = getRegisteredMethod(method);
        assert.ok(registered);
        assert.deepEqual(
            [...Value.Errors(registered.schema as TSchema, params)],
            [],
            "valid RPC params",
        );
        return registered.handler({
            workspace: { memoryStore: store },
            server: {},
            params,
        } as unknown as MethodCtx<unknown>);
    }

    it("roundtrips compact JSON provenance and preserves legacy topics", async () => {
        await store.appendEntry({ ...entry, sources: [source, toolSource] });
        const raw = readFileSync(topicPath(), "utf8");
        assert.ok(raw.includes(`sources: ${JSON.stringify([source, toolSource])}\n`));
        assert.deepEqual(
            matter(raw).data.sources,
            [source, toolSource],
            "sources are valid YAML flow syntax",
        );
        assert.deepEqual(parseTopicFrontmatter(raw)?.sources, [source, toolSource]);
        assert.deepEqual(LocalMemoryStore.openByKey(store.dirKey).getTopic(entry.id)?.sources, [
            source,
            toolSource,
        ]);
        writeFileSync(
            topicPath(),
            "---\nname: Legacy\ndescription: Old\ntype: user\n---\n\nLegacy body",
        );
        const legacy = LocalMemoryStore.openByKey(store.dirKey).getTopic(entry.id);
        assert.equal(legacy?.content, "Legacy body");
        assert.equal(legacy?.sources, undefined);
        await store.updateTopic(entry.id, "Updated legacy", { sources: [source] });
        assert.deepEqual(store.getTopic(entry.id)?.sources, [source]);
    });

    it("ignores malformed sources without dropping the memory", () => {
        for (const sources of [
            "not-json",
            "{}",
            '[null,{}, {"sessionId":"x","via":"guess","recordedAt":"bad"}]',
        ]) {
            const parsed = parseTopicFrontmatter(
                `---\nname: Legacy\ntype: user\nsources: ${sources}\n---\n\nbody`,
            );
            assert.equal(parsed?.name, "Legacy");
            assert.equal(parsed?.sources, undefined);
        }
        const parsed = parseTopicFrontmatter(
            `---\nname: Valid\ntype: user\nsources: ${JSON.stringify([null, { ...source, recordedAt: "invalid" }, { ...source, recordedAt: " " }, { ...source, sessionId: " " }, { ...source, entryId: 1 }, { ...source, entryId: " " }, { ...source, via: " " }, source])}\n---\n\nbody`,
        );
        assert.deepEqual(parsed?.sources, [source]);
    });

    it("unions sources by session, via and entry identity, keeping the original record", () => {
        const otherEntry = { ...source, entryId: "entry-b" };
        const otherVia = { ...source, via: "tool" as const };
        assert.deepEqual(
            memoryTypes.unionMemorySources(
                [source],
                [
                    { ...source, recordedAt: toolSource.recordedAt },
                    otherEntry,
                    otherVia,
                    toolSource,
                ],
            ),
            [source, otherEntry, otherVia, toolSource],
        );
        assert.deepEqual(memoryTypes.unionMemorySources(undefined, undefined), []);
    });

    it("preserves an explicit request when a duplicate source promotes it", () => {
        assert.deepEqual(
            memoryTypes.unionMemorySources(
                [{ ...source, explicitlyRequested: false }],
                [{ ...source, explicitlyRequested: true }],
            ),
            [{ ...source, explicitlyRequested: true }],
        );
    });

    it("does not rewrite or refresh trim-identical content", async () => {
        await store.appendEntry(entry);
        const before = statSync(topicPath()).mtimeMs;
        const result = await store.updateTopic(entry.id, ` \n${entry.content}\n `);
        assert.equal(result.updatedAt, entry.updatedAt);
        assert.equal(statSync(topicPath()).mtimeMs, before);
        assert.equal(result.content, entry.content);
    });

    it("persists new sources on no-op without refreshing timestamps and deduplicates retries", async () => {
        await store.appendEntry({ ...entry, sources: [source] });
        await store.updateTopic(entry.id, entry.content, { sources: [toolSource] });
        const result = await store.updateTopic(entry.id, entry.content, {
            sources: [{ ...toolSource, recordedAt: "2026-03-01T00:00:00.000Z" }],
        });
        assert.deepEqual(result.sources, [source, toolSource]);
        assert.equal(result.updatedAt, entry.updatedAt);
        assert.deepEqual(LocalMemoryStore.openByKey(store.dirKey).getTopic(entry.id)?.sources, [
            source,
            toolSource,
        ]);
        await store.appendEntry({ ...entry, id: "never-replaced", updatedAt: undefined });
        const neverReplaced = await store.updateTopic("never-replaced", entry.content, {
            sources: [source],
        });
        assert.equal(neverReplaced.updatedAt, undefined);
        await assert.rejects(
            store.updateTopic(entry.id, entry.content, {
                expectedContent: "stale",
                sources: [otherSource()],
            }),
            /changed/,
        );
        assert.deepEqual(store.getTopic(entry.id)?.sources, [source, toolSource]);
    });

    it("updates metadata and content while retaining type, creation and provenance", async () => {
        await store.appendEntry({ ...entry, sources: [source] });
        const result = await store.updateTopic(entry.id, "New conclusion", {
            name: "Renamed",
            description: "New relevance",
            sources: [toolSource],
            expectedContent: entry.content,
        });
        assert.equal(result.name, "Renamed");
        assert.equal(result.description, "New relevance");
        assert.equal(result.createdAt, entry.createdAt);
        assert.equal(result.type, entry.type);
        assert.notEqual(result.updatedAt, entry.updatedAt);
        assert.deepEqual(result.sources, [source, toolSource]);
        assert.equal(store.getTopic(entry.id)?.name, "Renamed");
        const metadataOnly = await store.updateTopic(entry.id, result.content, {
            name: "Metadata only",
        });
        assert.equal(metadataOnly.name, "Metadata only");
        assert.equal(store.getTopic(entry.id)?.description, "New relevance");
    });

    it("roundtrips an empty description without consuming the following frontmatter line", async () => {
        await store.appendEntry({ ...entry, description: "" });
        assert.equal(store.getTopic(entry.id)?.description, "");
        const updated = await store.updateTopic(entry.id, entry.content, { description: "   " });
        assert.equal(updated.description, "");
        assert.equal(LocalMemoryStore.openByKey(store.dirKey).getTopic(entry.id)?.description, "");
        const parsed = parseTopicFrontmatter("---\nname: \ndescription: \ntype: user\n---\n\nbody");
        assert.equal(parsed?.name, "");
        assert.equal(parsed?.description, "");
    });

    it("rejects blank topic names on storage and RPC add/replace", async () => {
        for (const name of ["", " ", "\n\t "]) {
            await assert.rejects(store.appendEntry({ ...entry, name }), /name/i);
        }
        await store.appendEntry(entry);
        for (const name of ["", " ", "\n\t "]) {
            await assert.rejects(store.updateTopic(entry.id, entry.content, { name }), /name/i);
            await assert.rejects(
                rpc("memory.upsert", {
                    workspace,
                    action: "replace",
                    id: entry.id,
                    content: entry.content,
                    name,
                }),
                /name|valid RPC params/i,
            );
        }
        assert.equal(store.getTopic(entry.id)?.name, entry.name);
        const replaced = await store.updateTopic(entry.id, entry.content, { description: "" });
        assert.equal(replaced.description, "");
    });

    it("enforces the 2000-character body cap on storage writes", async () => {
        assert.equal(MEMORY_CONTENT_MAX_CHARS, 2000);
        await store.appendEntry({ ...entry, content: "x".repeat(2000) });
        await assert.rejects(
            store.appendEntry({ ...entry, id: "too-long", content: "x".repeat(2001) }),
            /2000/,
        );
        await assert.rejects(store.updateTopic(entry.id, "x".repeat(2001)), /2000/);
        assert.equal(store.getTopic(entry.id)?.content.length, 2000);
    });

    it("guards metadata snapshots before applying content or source updates", async () => {
        await store.appendEntry({ ...entry, sources: [source] });
        await store.updateTopic(entry.id, entry.content, { name: "Edited during model call" });
        await assert.rejects(
            store.updateTopic(entry.id, "Stale rewrite", {
                expectedContent: entry.content,
                expectedName: entry.name,
                sources: [toolSource],
            }),
            /changed since it was read/,
        );
        await store.updateTopic(entry.id, entry.content, { description: "New user scope" });
        await assert.rejects(
            store.updateTopic(entry.id, entry.content, {
                expectedDescription: entry.description,
                name: "Stale title",
                sources: [toolSource],
            }),
            /changed since it was read/,
        );
        assert.equal(store.getTopic(entry.id)?.name, "Edited during model call");
        assert.deepEqual(store.getTopic(entry.id)?.sources, [source]);
        const updated = await store.updateTopic(entry.id, "Fresh rewrite", {
            expectedContent: entry.content,
            expectedName: "Edited during model call",
            expectedDescription: "New user scope",
        });
        assert.equal(updated.content, "Fresh rewrite");
    });

    it("compares stable persisted entry state independently of workspace and object key order", () => {
        const snapshot = { ...entry, sources: [source, source], workspaceId: workspace };
        const reordered: MemoryEntry = {
            ...entry,
            workspaceId: "different-workspace",
            sources: [
                {
                    entryId: source.entryId,
                    via: source.via,
                    recordedAt: source.recordedAt,
                    sessionId: source.sessionId,
                },
            ],
        };
        assert.equal(
            memoryTypes.memoryEntryState(snapshot),
            memoryTypes.memoryEntryState(reordered),
        );
        for (const changed of [
            { ...snapshot, name: "Changed" },
            { ...snapshot, description: "Changed" },
            { ...snapshot, type: "user" as const },
            { ...snapshot, content: "Changed" },
            { ...snapshot, createdAt: toolSource.recordedAt },
            { ...snapshot, updatedAt: toolSource.recordedAt },
            { ...snapshot, sources: [source, toolSource] },
        ]) {
            assert.notEqual(
                memoryTypes.memoryEntryState(changed),
                memoryTypes.memoryEntryState(snapshot),
            );
        }
        assert.equal(
            memoryTypes.memoryEntryState(entry),
            memoryTypes.memoryEntryState({ ...entry, sources: [] }),
        );
    });

    for (const edit of ["metadata", "provenance"] as const) {
        it(`rejects stale expectedEntry after an earlier queued ${edit} edit on update, delete and archive`, async () => {
            for (const operation of ["update", "delete", "archive"] as const) {
                const id = `${operation}-${edit}`;
                await store.appendEntry({ ...entry, id, sources: [source] });
                const expectedEntry = store.getTopic(id);
                assert.ok(expectedEntry);
                const editing = store.updateTopic(
                    id,
                    entry.content,
                    edit === "metadata" ? { name: "New title" } : { sources: [toolSource] },
                );
                const staleWrite =
                    operation === "update"
                        ? store.updateTopic(id, "Stale rewrite", { expectedEntry })
                        : operation === "delete"
                          ? store.deleteTopic(id, { expectedEntry })
                          : store.archiveTopic(id, { expectedEntry });
                await assert.rejects(staleWrite, /changed since it was read/);
                await editing;
                const current = store.getTopic(id);
                assert.ok(current);
                assert.equal(current.content, entry.content);
                assert.equal(current.name, edit === "metadata" ? "New title" : entry.name);
                assert.deepEqual(
                    current.sources,
                    edit === "provenance" ? [source, toolSource] : [source],
                );
            }
        });

        it(`checks restore snapshot inside the queue after an archived ${edit} edit`, async () => {
            await store.appendEntry({ ...entry, sources: [source] });
            await store.archiveTopic(entry.id);
            const expectedEntry = store.listArchivedTopics()[0];
            assert.ok(expectedEntry);
            const archivedPath = join(store.topicDir, "archive", `${entry.id}.md`);
            const before = readFileSync(archivedPath, "utf8");
            const restoring = store.restoreTopic(entry.id, { expectedEntry });
            // Runs after restore is submitted but before its queued synchronous tick.
            const changed =
                edit === "metadata"
                    ? before.replace("name: Theme", "name: Edited while queued")
                    : before.replace(
                          `sources: ${JSON.stringify([source])}`,
                          `sources: ${JSON.stringify([source, toolSource])}`,
                      );
            assert.notEqual(changed, before);
            writeFileSync(archivedPath, changed);
            await assert.rejects(restoring, /changed since it was read/);
            assert.equal(store.getTopic(entry.id), undefined);
            assert.ok(existsSync(archivedPath));
            assert.equal(readFileSync(archivedPath, "utf8"), changed);
            const fresh = store.listArchivedTopics()[0];
            assert.ok(fresh);
            await store.restoreTopic(entry.id, {
                expectedEntry: { ...fresh, workspaceId: "irrelevant" },
            });
            assert.equal(existsSync(archivedPath), false);
            assert.deepEqual(store.getTopic(entry.id)?.sources, fresh.sources);
            assert.equal(store.getTopic(entry.id)?.name, fresh.name);
        });
    }

    it("accepts a matching expectedEntry for update, archive and delete", async () => {
        await store.appendEntry({ ...entry, sources: [source] });
        const snapshot = store.getTopic(entry.id);
        assert.ok(snapshot);
        const updated = await store.updateTopic(entry.id, "New body", {
            expectedEntry: { ...snapshot, workspaceId: "irrelevant" },
        });
        await store.archiveTopic(entry.id, { expectedEntry: updated });
        await store.restoreTopic(entry.id, { expectedEntry: updated });
        await store.deleteTopic(entry.id, { expectedEntry: updated });
        assert.equal(store.getTopic(entry.id), undefined);
    });

    it("returns the validated archive snapshot even when the archived file changes later", async () => {
        await store.appendEntry({ ...entry, sources: [source] });
        const expectedEntry = store.getTopic(entry.id);
        assert.ok(expectedEntry);
        const archived = await store.archiveTopic(entry.id, { expectedEntry });
        const archivedPath = join(store.topicDir, "archive", `${entry.id}.md`);
        writeFileSync(
            archivedPath,
            readFileSync(archivedPath, "utf8")
                .replace("name: Theme", "name: Changed after archive")
                .replace(
                    `sources: ${JSON.stringify([source])}`,
                    `sources: ${JSON.stringify([source, toolSource])}`,
                ),
        );
        assert.equal(archived.archivedAt !== undefined, true);
        const { archivedAt: _archivedAt, ...withoutArchiveAge } = archived;
        assert.deepEqual(withoutArchiveAge, expectedEntry);
        assert.equal(store.listArchivedTopics()[0]?.name, "Changed after archive");
        assert.deepEqual(store.listArchivedTopics()[0]?.sources, [source, toolSource]);
    });

    it("attributes tool add and replace to their sessions and lists all sources", async () => {
        const { withMemoryWriteOrigin } = await import("../../src/memory/writeOrigin.ts");
        await withMemoryWriteOrigin("tool-session-a", () =>
            rpc("memory.upsert", {
                workspace,
                action: "add",
                id: entry.id,
                name: entry.name,
                type: entry.type,
                content: "x".repeat(1500),
            }),
        );
        const initial = store.getTopic(entry.id);
        assert.equal(initial?.sources?.[0]?.sessionId, "tool-session-a");
        assert.equal(initial?.sources?.[0]?.via, "tool");
        assert.ok(Number.isFinite(Date.parse(initial?.sources?.[0]?.recordedAt ?? "")));
        await withMemoryWriteOrigin("tool-session-b", () =>
            rpc("memory.upsert", {
                workspace,
                action: "replace",
                id: entry.id,
                name: "New title",
                description: "Better relevance",
                content: "Revised conclusion",
                type: "user",
            }),
        );
        const updated = store.getTopic(entry.id);
        assert.equal(updated?.createdAt, initial?.createdAt);
        assert.equal(updated?.type, entry.type);
        assert.equal(updated?.name, "New title");
        assert.equal(updated?.description, "Better relevance");
        assert.deepEqual(
            updated?.sources?.map((s) => s.sessionId),
            ["tool-session-a", "tool-session-b"],
        );
        const listed = (await rpc("memory.list", { workspace })) as { topics: MemoryEntry[] };
        assert.deepEqual(listed.topics[0]?.sources, updated?.sources);
    });

    it("passes explicit request provenance and keeps the promoted marker sticky", async () => {
        await rpc("memory.upsert", {
            workspace,
            action: "add",
            id: entry.id,
            name: entry.name,
            type: entry.type,
            content: entry.content,
            explicitlyRequested: false,
        });
        assert.equal(store.getTopic(entry.id)?.explicitlyRequested, false);
        await rpc("memory.upsert", {
            workspace,
            action: "replace",
            id: entry.id,
            content: "Promoted",
            explicitlyRequested: true,
        });
        await rpc("memory.upsert", {
            workspace,
            action: "replace",
            id: entry.id,
            content: "Still promoted",
            explicitlyRequested: false,
        });
        assert.equal(store.getTopic(entry.id)?.explicitlyRequested, true);
    });

    it("ignores forged public provenance and rejects empty add content", async () => {
        const registered = getRegisteredMethod("memory.upsert");
        assert.ok(registered);
        assert.equal(
            "sourceSessionId" in (registered.schema as { properties: object }).properties,
            false,
        );
        for (const sourceSessionId of ["forged-session", "", "   ", 42, null]) {
            const params = {
                workspace,
                action: "add",
                id: entry.id,
                name: entry.name,
                type: entry.type,
                content: entry.content,
                sourceSessionId,
            };
            await rpc("memory.upsert", params);
            assert.equal(store.getTopic(entry.id)?.sources, undefined);
            await rpc("memory.upsert", { ...params, action: "replace", content: "Changed" });
            assert.equal(store.getTopic(entry.id)?.sources, undefined);
            await store.deleteTopic(entry.id);
        }
        await assert.rejects(
            rpc("memory.upsert", {
                workspace,
                action: "add",
                id: entry.id,
                name: entry.name,
                type: entry.type,
                content: "   ",
            }),
            /content/,
        );
        assert.equal(store.getTopic(entry.id), undefined);
    });

    it("carries runtime session identity through async RPC context without a model parameter", async () => {
        const { currentMemoryWriteOrigin } = await import("../../src/memory/writeOrigin.ts");
        const tool = createMemoryTool();
        assert.doesNotMatch(JSON.stringify(tool.parameters), /sourceSessionId/);
        const calls: unknown[] = [];
        const origins: unknown[] = [];
        await invokeTool(
            tool,
            { action: "replace", id: entry.id, content: entry.content, sourceSessionId: "spoofed" },
            {
                workspace,
                sessionId: asSessionId("runtime-session"),
                call: async (_method: unknown, _workspace: unknown, params: unknown) => {
                    origins.push(currentMemoryWriteOrigin());
                    calls.push(params);
                    return { ok: true, outcome: "updated" };
                },
            },
        );
        assert.deepEqual(origins, ["runtime-session"]);
        assert.equal("sourceSessionId" in (calls[0] as object), false);
        assert.equal(currentMemoryWriteOrigin(), undefined);
    });

    it("attributes the real tool-to-handler path to the full runtime session identity", async () => {
        const sessionId = "session-full-thread-identity";
        const call = async (_method: unknown, _workspace: unknown, params: unknown) => {
            await Promise.resolve();
            return rpc("memory.upsert", params);
        };
        const context = { workspace, sessionId: asSessionId(sessionId), call };
        await invokeTool(
            createMemoryTool(),
            {
                action: "add",
                id: entry.id,
                name: entry.name,
                type: entry.type,
                content: entry.content,
                sourceSessionId: "forged",
            },
            context,
        );
        assert.equal(store.getTopic(entry.id)?.sources?.[0]?.sessionId, sessionId);
        assert.equal(store.getTopic(entry.id)?.sources?.[0]?.via, "tool");
        await invokeTool(
            createMemoryTool(),
            {
                action: "replace",
                id: entry.id,
                content: "Revised",
                sourceSessionId: "another-forgery",
            },
            context,
        );
        assert.equal(store.getTopic(entry.id)?.sources?.length, 1);
        assert.equal(store.getTopic(entry.id)?.sources?.[0]?.sessionId, sessionId);
    });

    it("isolates concurrent trusted tool origins and restores nested async context", async () => {
        const { withMemoryWriteOrigin, currentMemoryWriteOrigin } = await import(
            "../../src/memory/writeOrigin.ts"
        );
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const first = withMemoryWriteOrigin("first", async () => {
            await gate;
            assert.equal(currentMemoryWriteOrigin(), "first");
            await withMemoryWriteOrigin("nested", async () => {
                await Promise.resolve();
                assert.equal(currentMemoryWriteOrigin(), "nested");
            });
            assert.equal(currentMemoryWriteOrigin(), "first");
            await rpc("memory.upsert", {
                workspace,
                action: "add",
                id: "first",
                name: "First",
                type: "user",
                content: entry.content,
                sourceSessionId: "forged",
            });
        });
        const second = withMemoryWriteOrigin("second", async () => {
            assert.equal(currentMemoryWriteOrigin(), "second");
            await rpc("memory.upsert", {
                workspace,
                action: "add",
                id: "second",
                name: "Second",
                type: "user",
                content: entry.content,
            });
            release();
        });
        await Promise.all([first, second]);
        assert.equal(store.getTopic("first")?.sources?.[0]?.sessionId, "first");
        assert.equal(store.getTopic("second")?.sources?.[0]?.sessionId, "second");
        assert.equal(currentMemoryWriteOrigin(), undefined);
        await assert.rejects(
            withMemoryWriteOrigin("throws", async () => {
                throw new Error("expected failure");
            }),
            /expected failure/,
        );
        assert.equal(currentMemoryWriteOrigin(), undefined);
        for (const invalid of ["", "  "]) {
            await assert.rejects(
                async () => withMemoryWriteOrigin(invalid, async () => undefined),
                /session/i,
            );
        }
    });
});

function otherSource() {
    return { ...toolSource, sessionId: "stale-session" };
}
