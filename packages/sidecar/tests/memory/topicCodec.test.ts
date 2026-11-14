import { strict as assert } from "node:assert";
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import matter from "gray-matter";
import { LocalMemoryStore, parseTopicFrontmatter } from "../../src/memory/local/store.ts";

const literals = ["A # B", "key: value", "'quoted'", '"quoted"', "true", "2026-01-02", "中文 🌮"];
const source = { sessionId: "s", recordedAt: "2020-01-01T00:00:00.000Z", via: "tool" };
const body = "first\r\n---\r\nlast";

function legacy(value: string): string {
    return `---\r\nname: ${value}\r\ndescription: ${value}\r\ntype: user\r\ncreatedAt: '2020-01-01'\r\nupdatedAt: true\r\nexplicitlyRequested: false\r\nsources: ${JSON.stringify([source, source, null])}\r\n---\r\n\r\n  ${body}  \r\n`;
}

describe("topic codec", () => {
    let root: string;
    let previousHome: string | undefined;
    let store: LocalMemoryStore;

    beforeEach(() => {
        previousHome = process.env.TACO_HOME;
        root = mkdtempSync(join(tmpdir(), "taco-topic-codec-"));
        process.env.TACO_HOME = root;
        store = new LocalMemoryStore();
        store.initialize("codec-workspace");
        mkdirSync(join(store.topicDir, "archive", "history"), { recursive: true });
    });

    afterEach(() => {
        if (previousHome === undefined) Reflect.deleteProperty(process.env, "TACO_HOME");
        else process.env.TACO_HOME = previousHome;
        rmSync(root, { recursive: true, force: true });
    });

    for (const value of literals) {
        it(`preserves unmarked literal ${JSON.stringify(value)} in active and archived files`, () => {
            const raw = legacy(value);
            const activePath = join(store.topicDir, "file-id.md");
            const archivePath = join(store.topicDir, "archive", "file-id.md");
            writeFileSync(activePath, raw);
            writeFileSync(archivePath, raw);
            const active = store.getTopic("file-id");
            assert.ok(active);
            assert.equal(active.id, "file-id");
            assert.equal(active.name, value);
            assert.equal(active.description, value);
            assert.equal(active.createdAt, "'2020-01-01'");
            assert.equal(active.updatedAt, "true");
            assert.equal(active.explicitlyRequested, false);
            assert.deepEqual(active.sources, [source]);
            assert.equal(active.content, body);
            assert.deepEqual(store.listArchivedTopics(), [active]);
            assert.equal(readFileSync(activePath, "utf8"), raw);
            assert.equal(readFileSync(archivePath, "utf8"), raw);
            assert.equal(parseTopicFrontmatter(raw)?.name, value);
        });
    }

    it("uses file ids and mtime for missing timestamps, including archive history ids", async () => {
        const raw = "---\nname: Legacy\ndescription: \ntype: reference\n---\n\n body \n---\nend ";
        const paths = [
            join(store.topicDir, "legacy.id.md"),
            join(store.topicDir, "archive", "legacy.id.md"),
            join(store.topicDir, "archive", "history", "legacy.stamp.md"),
        ];
        for (const path of paths) writeFileSync(path, raw);
        assert.equal(
            store.getTopic("legacy.id")?.createdAt,
            statSync(paths[0]).mtime.toISOString(),
        );
        assert.equal(store.listArchivedTopics()[0]?.id, "legacy.id");
        assert.equal(
            store.listArchivedTopics()[0]?.createdAt,
            statSync(paths[1]).mtime.toISOString(),
        );
        const ids: string[] = [];
        await store.purgeArchivedTopics({
            retentionDays: 7,
            now: new Date("2100-01-01T00:00:00.000Z"),
            beforeDelete: (candidates) => {
                for (const candidate of candidates) {
                    ids.push(candidate.entry.id);
                    const path = join(store.topicDir, "archive", candidate.key);
                    assert.equal(candidate.entry.createdAt, statSync(path).mtime.toISOString());
                    assert.equal(candidate.entry.content, "body \n---\nend");
                }
            },
        });
        assert.deepEqual(ids.sort(), ["legacy", "legacy"]);
    });

    for (const value of [...literals, "first\r\nsecond"]) {
        it(`writes standard YAML and roundtrips ${JSON.stringify(value)} through archive and restore`, async () => {
            const normalized = value.replace(/[\r\n]+/g, " ");
            await store.appendEntry({
                id: "roundtrip",
                name: value,
                description: value,
                type: "reference",
                content: ` \r\n${body} \r\n`,
                createdAt: "2020-01-01T00:00:00.000Z",
                explicitlyRequested: false,
                sources: [
                    { ...source, via: "tool" },
                    { ...source, via: "tool" },
                ],
            });
            const raw = readFileSync(join(store.topicDir, "roundtrip.md"), "utf8");
            const data = matter(raw).data;
            assert.equal(data.topicCodec, 1);
            assert.equal(data.name, normalized);
            assert.equal(data.description, normalized);
            assert.equal(
                data.createdAt instanceof Date ? data.createdAt.toISOString() : data.createdAt,
                "2020-01-01T00:00:00.000Z",
            );
            assert.deepEqual(data.sources, [source]);
            const snapshot = store.getTopic("roundtrip");
            assert.ok(snapshot);
            assert.equal(snapshot.name, normalized);
            assert.equal(snapshot.content, body);
            const archived = await store.archiveTopic("roundtrip", { expectedEntry: snapshot });
            assert.deepEqual(store.listArchivedTopics(), [archived]);
            const cleanup = await store.purgeArchivedTopics({
                retentionDays: 7,
                now: new Date("2100-01-01T00:00:00.000Z"),
                beforeDelete: (candidates) => {
                    assert.deepEqual(
                        candidates.map((candidate) => candidate.entry),
                        [archived],
                    );
                },
                protectedIds: new Set(["unrelated"]),
            });
            assert.equal(cleanup.deleted, 1);
            await store.appendEntry(snapshot);
            await store.archiveTopic("roundtrip");
            await store.restoreTopic("roundtrip", { expectedEntry: snapshot });
            assert.deepEqual(store.getTopic("roundtrip"), snapshot);
            const updated = await store.updateTopic("roundtrip", body, {
                expectedEntry: snapshot,
                name: `Updated: ${value}`,
                description: "",
            });
            assert.equal(updated.name, `Updated: ${normalized}`);
            assert.equal(updated.description, "");
            assert.equal(
                LocalMemoryStore.openByKey(store.dirKey).getTopic("roundtrip")?.name,
                updated.name,
            );
        });
    }

    it("reads marked YAML with CRLF, empty descriptions and validated source union", () => {
        const raw = `---\r\ntopicCodec: 1\r\nname: 'A: B # C'\r\ndescription: ''\r\ntype: user\r\ncreatedAt: '2020-01-01T00:00:00.000Z'\r\nexplicitlyRequested: false\r\nsources: ${JSON.stringify([null, { ...source, recordedAt: "bad" }, { ...source, entryId: " " }, { ...source, explicitlyRequested: "true" }, source, { ...source, explicitlyRequested: true }])}\r\n---\r\n\r\n${body}\r\n`;
        writeFileSync(join(store.topicDir, "marked.md"), raw);
        const parsed = store.getTopic("marked");
        assert.equal(parsed?.name, "A: B # C");
        assert.equal(parsed?.description, "");
        assert.equal(parsed?.createdAt, "2020-01-01T00:00:00.000Z");
        assert.equal(parsed?.explicitlyRequested, false);
        assert.equal(parsed?.content, body);
        assert.deepEqual(parsed?.sources, [{ ...source, explicitlyRequested: true }]);
    });

    it("rejects invalid marked YAML and unsupported versions without a legacy fallback", () => {
        for (const header of [
            "topicCodec: 1\nname: [broken\ntype: user",
            String.raw`"topic\u0043odec": 1` + "\nname: [broken\ntype: user",
            "topicCodec: 2\nname: Future\ntype: user",
            "topicCodec: 1\nname: Valid\ntype: invalid",
        ]) {
            assert.equal(parseTopicFrontmatter(`---\n${header}\n---\nbody`), null);
        }
    });

    it("preserves false explicit metadata in archive cleanup snapshots", async () => {
        writeFileSync(join(store.topicDir, "archive", "legacy.md"), legacy("Legacy"));
        await store.purgeArchivedTopics({
            retentionDays: 7,
            now: new Date("2100-01-01T00:00:00.000Z"),
            beforeDelete: (candidates) => {
                assert.equal(candidates.length, 1);
                assert.equal(candidates[0]?.entry.explicitlyRequested, false);
            },
        });
    });

    it("preserves a body starting with a fence and accepts CAS against the update result", async () => {
        writeFileSync(join(store.topicDir, "legacy.md"), legacy("A # B"));
        const before = store.getTopic("legacy");
        assert.ok(before);
        const content = "---\r\nname: body metadata\r\n---\r\n正文";
        const updated = await store.updateTopic("legacy", ` \n${content}\n `, {
            expectedEntry: before,
        });
        assert.equal(updated.name, "A # B");
        assert.equal(updated.content, content);
        assert.equal(store.getTopic("legacy")?.content, content);
        const raw = readFileSync(join(store.topicDir, "legacy.md"), "utf8");
        assert.equal(matter(raw).data.topicCodec, 1);
        assert.ok(raw.endsWith(`${content}\n`));
        const unchanged = await store.updateTopic("legacy", content, { expectedEntry: updated });
        assert.deepEqual(unchanged, updated);
        assert.equal(readFileSync(join(store.topicDir, "legacy.md"), "utf8"), raw);
        await store.deleteTopic("legacy", { expectedEntry: updated });
    });

    it("normalizes marked source dates in active, archive and cleanup reads", async () => {
        const raw =
            "---\ntopicCodec: 1\nname: Dates\ntype: user\nsources:\n  - sessionId: s\n    via: tool\n    recordedAt: 2020-01-01T08:00:00+08:00\n---\nbody";
        writeFileSync(join(store.topicDir, "dates.md"), raw);
        writeFileSync(join(store.topicDir, "archive", "dates.md"), raw);
        assert.deepEqual(store.getTopic("dates")?.sources, [source]);
        assert.deepEqual(store.listArchivedTopics()[0]?.sources, [source]);
        await store.purgeArchivedTopics({
            retentionDays: 7,
            now: new Date("2100-01-01T00:00:00.000Z"),
            beforeDelete: (candidates) => {
                assert.equal(candidates.length, 1);
                assert.deepEqual(candidates[0]?.entry.sources, [source]);
            },
        });
    });

    it("keeps legacy source timestamp strings literal", () => {
        const recordedAt = "2020-01-01T08:00:00+08:00";
        const raw = legacy("A # B").replaceAll(source.recordedAt, recordedAt);
        writeFileSync(join(store.topicDir, "legacy.md"), raw);
        writeFileSync(join(store.topicDir, "archive", "legacy.md"), raw);
        assert.deepEqual(store.getTopic("legacy")?.sources, [{ ...source, recordedAt }]);
        assert.deepEqual(store.listArchivedTopics()[0]?.sources, [{ ...source, recordedAt }]);
    });

    it("does not treat marker text inside an unmarked YAML block value as a codec marker", () => {
        const raw =
            "---\nname: A # B\ndescription: 'quoted'\ntype: user\nnotes: |\n  topicCodec: 2\n  \"topicCodec\": 2\n---\nbody";
        writeFileSync(join(store.topicDir, "unmarked.md"), raw);
        writeFileSync(join(store.topicDir, "archive", "unmarked.md"), raw);
        assert.equal(store.getTopic("unmarked")?.name, "A # B");
        assert.equal(store.getTopic("unmarked")?.description, "'quoted'");
        assert.deepEqual(store.listArchivedTopics(), store.listTopics());
    });

    for (const key of [
        '"topicCodec"',
        "'topicCodec'",
        "topicCodec ",
        String.raw`"topic\u0043odec"`,
    ]) {
        it(`recognizes YAML marker ${key} and rejects unknown versions in active and archive reads`, async () => {
            const path = join(store.topicDir, "version.md");
            const archivedPath = join(store.topicDir, "archive", "version.md");
            const raw = `---\n${key}: 2\nname: A # B\ndescription: 'quoted'\ntype: user\ncreatedAt: '2020-01-01T00:00:00.000Z'\n---\nbody`;
            writeFileSync(path, raw);
            writeFileSync(archivedPath, raw);
            assert.equal(parseTopicFrontmatter(raw), null);
            assert.deepEqual(store.listTopics(), []);
            assert.deepEqual(store.listArchivedTopics(), []);
            assert.deepEqual(
                await store.purgeArchivedTopics({
                    retentionDays: 7,
                    now: new Date("2100-01-01T00:00:00.000Z"),
                }),
                { deleted: 0, skipped: 1 },
            );
            assert.equal(readFileSync(path, "utf8"), raw);
            assert.equal(readFileSync(archivedPath, "utf8"), raw);
            const supported = raw.replace(`${key}: 2`, `${key}: 1`);
            writeFileSync(path, supported);
            writeFileSync(archivedPath, supported);
            assert.equal(store.getTopic("version")?.name, "A");
            assert.equal(store.getTopic("version")?.description, "quoted");
            assert.deepEqual(store.listArchivedTopics(), store.listTopics());
        });
    }
    for (const operation of ["append", "restore"] as const) {
        it(`${operation} preserves an existing topic with an unsupported codec`, async () => {
            const raw =
                "---\ntopicCodec: 2\nname: Future\ntype: user\n---\noriginal future content";
            const path = join(store.topicDir, "future.md");
            const archivedPath = join(store.topicDir, "archive", "future.md");
            writeFileSync(path, raw);
            writeFileSync(archivedPath, legacy("Archived"));
            const archived = readFileSync(archivedPath, "utf8");
            await assert.rejects(
                operation === "append"
                    ? store.appendEntry({
                          id: "future",
                          name: "Replacement",
                          description: "",
                          type: "user",
                          content: "replacement",
                          createdAt: "2020-01-01T00:00:00.000Z",
                      })
                    : store.restoreTopic("future"),
                /memory topic already exists/,
            );
            assert.equal(readFileSync(path, "utf8"), raw);
            assert.equal(readFileSync(archivedPath, "utf8"), archived);
        });
    }
    it("keeps rollback timestamps and provenance readable by the legacy line reader", async () => {
        const createdAt = "2020-01-01T00:00:00.000Z";
        const updatedAt = "2020-02-01T00:00:00.000Z";
        const archivedAt = "2020-03-01T00:00:00.000Z";
        await store.appendEntry({
            id: "rollback",
            name: "A: B # C",
            description: "true",
            type: "user",
            createdAt,
            updatedAt,
            archivedAt,
            sources: [{ ...source, via: "tool" }],
            content: "body\ncreatedAt: 'literal'\nsources:\n  - body list",
        });
        const raw = readFileSync(join(store.topicDir, "rollback.md"), "utf8");
        const header = raw.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";
        const oldGet = (key: string) =>
            header.match(new RegExp(`^${key}:[\\t ]*([^\\r\\n]*)$`, "m"))?.[1]?.trim() ?? "";
        for (const [key, expected] of Object.entries({ createdAt, updatedAt, archivedAt })) {
            assert.equal(oldGet(key), expected);
            assert.ok(Number.isFinite(Date.parse(oldGet(key))));
        }
        assert.deepEqual(JSON.parse(oldGet("sources")), [source]);
        assert.equal(parseTopicFrontmatter(raw)?.name, "A: B # C");
        assert.equal(
            oldGet("name"),
            "'A: B # C'",
            "special titles still require an explicit downgrade warning",
        );
        assert.equal(
            store.getTopic("rollback")?.content,
            "body\ncreatedAt: 'literal'\nsources:\n  - body list",
        );
        assert.equal(store.getTopic("rollback")?.createdAt, createdAt);
        assert.equal(store.getTopic("rollback")?.archivedAt, archivedAt);
    });

    it("normalizes numeric YAML source identifiers while keeping legacy validation strict", () => {
        const header =
            "topicCodec: 1\nname: Source\ntype: user\nsources:\n  - sessionId: 123\n    entryId: 456\n    via: tool\n    recordedAt: '2020-01-01T00:00:00.000Z'";
        const raw = `---\n${header}\n---\nbody`;
        assert.deepEqual(parseTopicFrontmatter(raw)?.sources, [
            { ...source, sessionId: "123", entryId: "456" },
        ]);
        assert.equal(
            parseTopicFrontmatter(
                `---\nname: Legacy\ntype: user\nsources: ${JSON.stringify([{ ...source, sessionId: 123, entryId: 456 }])}\n---\nbody`,
            )?.sources,
            undefined,
        );
    });

    it("reads only the target during CAS and rejects paths outside the topic directory", async (t) => {
        for (const id of ["target", "unrelated"])
            writeFileSync(join(store.topicDir, `${id}.md`), legacy(id));
        writeFileSync(join(store.topicDir, "archive", "restore.md"), legacy("Archived"));
        const target = store.getTopic("target");
        const archived = store.listArchivedTopics()[0];
        assert.ok(target);
        assert.ok(archived);
        const originalRead = fs.readFileSync;
        const paths: string[] = [];
        t.mock.method(fs, "readFileSync", (...args: Parameters<typeof originalRead>) => {
            paths.push(String(args[0]));
            return originalRead(...args);
        });
        syncBuiltinESMExports();
        try {
            await store.updateTopic("target", "changed", { expectedEntry: target });
            assert.deepEqual(paths, [join(store.topicDir, "target.md")]);
            paths.length = 0;
            await store.restoreTopic("restore", { expectedEntry: archived });
            assert.deepEqual(paths, [join(store.topicDir, "archive", "restore.md")]);
            await assert.rejects(store.updateTopic("../outside", "bad"), /unknown memory topic/);
            await assert.rejects(store.deleteTopic("archive/restore"), /unknown memory topic/);
        } finally {
            t.mock.restoreAll();
            syncBuiltinESMExports();
        }
    });
});
