/**
 * Session JSONL header / facts scanner — v3 metadata bag recovery and the
 * first-line classifier used before repo.open rewrites the file.
 *
 * Run: cd packages/sidecar && pnpm exec tsx --test tests/runtime/sessionMetadataReader.test.ts
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { SESSION_FACTS_NAMESPACE } from "../../src/runtime/session/sessionFacts.ts";
import {
    parseLegacyV3TacoMetadata,
    parseSessionFileHeader,
    readLegacyFactsFromPath,
    readSessionMetadataFromDisk,
} from "../../src/runtime/session/sessionMetadataReader.ts";

describe("parseLegacyV3TacoMetadata", () => {
    it("extracts the structured fields taco persisted on v3 headers", () => {
        const facts = parseLegacyV3TacoMetadata({
            kind: "subagent",
            agentType: "explorer",
            parentSessionId: "parent-1",
            parentToolCallId: "call_1",
            depth: 1,
        });
        assert.deepEqual(facts, {
            kind: "subagent",
            agentType: "explorer",
            parentSessionId: "parent-1",
            parentToolCallId: "call_1",
            depth: 1,
        });
    });

    it("drops unknown keys and wrong types rather than guessing", () => {
        const facts = parseLegacyV3TacoMetadata({
            kind: "sidekick",
            agentType: 12,
            parentSessionId: "",
            depth: -1,
            extra: true,
        });
        assert.deepEqual(facts, {});
    });

    it("returns empty facts for a missing or non-object bag", () => {
        assert.deepEqual(parseLegacyV3TacoMetadata(undefined), {});
        assert.deepEqual(parseLegacyV3TacoMetadata(null), {});
        assert.deepEqual(parseLegacyV3TacoMetadata("subagent"), {});
        assert.deepEqual(parseLegacyV3TacoMetadata([]), {});
    });
});

describe("parseSessionFileHeader", () => {
    it("reads parentSessionId off a v4 header", () => {
        const parsed = parseSessionFileHeader(
            JSON.stringify({
                v: 4,
                kind: "header",
                id: "s1",
                createdAt: 1,
                storageVersion: 1,
                cwd: "/ws",
                parentSessionId: "parent-1",
            }),
        );
        assert.deepEqual(parsed, { format: "v4", parentSessionId: "parent-1" });
    });

    it("treats an empty v4 parentSessionId as absent", () => {
        const parsed = parseSessionFileHeader(
            JSON.stringify({
                v: 4,
                kind: "header",
                id: "s1",
                createdAt: 1,
                storageVersion: 1,
                cwd: "/ws",
                parentSessionId: "",
            }),
        );
        assert.deepEqual(parsed, { format: "v4", parentSessionId: undefined });
    });

    it("recovers the taco metadata bag from a v3 header", () => {
        const parsed = parseSessionFileHeader(
            JSON.stringify({
                type: "session",
                version: 3,
                id: "s1",
                timestamp: "2026-08-13T16:17:40.770Z",
                cwd: "/ws",
                metadata: {
                    kind: "subagent",
                    agentType: "explorer",
                    parentSessionId: "parent-1",
                    parentToolCallId: "call_1",
                    depth: 1,
                },
            }),
        );
        assert.equal(parsed.format, "v3");
        if (parsed.format !== "v3") return;
        assert.equal(parsed.facts.kind, "subagent");
        assert.equal(parsed.facts.agentType, "explorer");
        assert.equal(parsed.facts.parentSessionId, "parent-1");
        assert.equal(parsed.facts.parentToolCallId, "call_1");
        assert.equal(parsed.facts.depth, 1);
    });

    it("returns unknown for unparseable or unsupported first lines", () => {
        assert.equal(parseSessionFileHeader("not-json").format, "unknown");
        assert.equal(parseSessionFileHeader("[]").format, "unknown");
        assert.equal(
            parseSessionFileHeader(JSON.stringify({ v: 5, kind: "header" })).format,
            "unknown",
        );
    });
});

describe("readSessionMetadataFromDisk", () => {
    const dirs: string[] = [];
    afterEach(() => {
        for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
        dirs.length = 0;
    });

    function tmpFile(contents: string): string {
        const dir = mkdtempSync(join(tmpdir(), "taco-meta-"));
        dirs.push(dir);
        const path = join(dir, "session.jsonl");
        writeFileSync(path, contents);
        return path;
    }

    it("surfaces v3 header metadata as facts without opening the file", async () => {
        const path = tmpFile(
            `${JSON.stringify({
                type: "session",
                version: 3,
                id: "s1",
                timestamp: "2026-08-13T16:17:40.770Z",
                cwd: "/ws",
                metadata: {
                    kind: "subagent",
                    agentType: "explorer",
                    parentSessionId: "parent-1",
                    parentToolCallId: "call_1",
                    depth: 1,
                },
            })}\n${JSON.stringify({
                type: "message",
                id: "m1",
                parentId: null,
                timestamp: "2026-08-13T16:17:40.795Z",
                message: { role: "user", content: [{ type: "text", text: "hi" }] },
            })}\n`,
        );
        const { facts } = await readSessionMetadataFromDisk(path);
        assert.equal(facts.kind, "subagent");
        assert.equal(facts.agentType, "explorer");
        assert.equal(facts.parentSessionId, "parent-1");
    });

    it("prefers a later taco.session.facts value over the v3 header bag", async () => {
        const path = tmpFile(
            `${JSON.stringify({
                type: "session",
                version: 3,
                id: "s1",
                timestamp: "2026-08-13T16:17:40.770Z",
                cwd: "/ws",
                metadata: { kind: "subagent" },
            })}\n${JSON.stringify({
                kind: "value",
                op: "set",
                seq: 1,
                namespace: SESSION_FACTS_NAMESPACE,
                key: "",
                value: { kind: "main" },
            })}\n`,
        );
        const { facts } = await readSessionMetadataFromDisk(path);
        assert.equal(facts.kind, "main");
    });

    it("does not let an empty v3 header bag wipe a kind-less facts value", async () => {
        const path = tmpFile(
            `${JSON.stringify({
                type: "session",
                version: 3,
                id: "s1",
                timestamp: "2026-08-13T16:17:40.770Z",
                cwd: "/ws",
            })}\n${JSON.stringify({
                kind: "value",
                op: "set",
                seq: 1,
                namespace: SESSION_FACTS_NAMESPACE,
                key: "",
                value: { parentSessionId: "parent-1", depth: 1 },
            })}\n`,
        );
        const { facts } = await readSessionMetadataFromDisk(path);
        assert.equal(facts.parentSessionId, "parent-1");
        assert.equal(facts.depth, 1);
        assert.equal(facts.kind, undefined);
    });

    it("returns the last message timestamp for v4 and v3 files", async () => {
        const v4 = tmpFile(
            `${JSON.stringify({
                v: 4,
                kind: "header",
                id: "s1",
                createdAt: 1,
                storageVersion: 1,
                cwd: "/ws",
            })}\n${JSON.stringify({
                kind: "entry",
                id: "e1",
                parentId: null,
                seq: 1,
                timestamp: 1_000,
                type: "message",
                message: { role: "user", content: [{ type: "text", text: "first" }] },
            })}\n${JSON.stringify({
                kind: "entry",
                id: "e2",
                parentId: "e1",
                seq: 2,
                timestamp: 2_000,
                type: "message",
                message: { role: "assistant", content: [{ type: "text", text: "second" }] },
            })}\n${JSON.stringify({
                kind: "value",
                op: "set",
                seq: 3,
                namespace: SESSION_FACTS_NAMESPACE,
                key: "",
                value: { kind: "main" },
            })}\n`,
        );
        const v3 = tmpFile(
            `${JSON.stringify({
                type: "session",
                version: 3,
                id: "s1",
                timestamp: "2026-08-13T16:17:40.770Z",
                cwd: "/ws",
            })}\n${JSON.stringify({
                type: "message",
                id: "m1",
                parentId: null,
                timestamp: "2026-08-13T16:17:40.795Z",
                message: { role: "user", content: [{ type: "text", text: "hi" }] },
            })}\n${JSON.stringify({
                type: "message",
                id: "m2",
                parentId: "m1",
                timestamp: "2026-08-13T16:18:00.000Z",
                message: { role: "assistant", content: [{ type: "text", text: "yo" }] },
            })}\n`,
        );
        const v4Meta = await readSessionMetadataFromDisk(v4);
        assert.equal(v4Meta.activityAt, 2_000);
        const v3Meta = await readSessionMetadataFromDisk(v3);
        assert.equal(v3Meta.activityAt, Date.parse("2026-08-13T16:18:00.000Z"));
    });

    it("ignores compaction and value-record timestamps when finding activity", async () => {
        const path = tmpFile(
            `${JSON.stringify({
                v: 4,
                kind: "header",
                id: "s1",
                createdAt: 1,
                storageVersion: 1,
                cwd: "/ws",
            })}\n${JSON.stringify({
                kind: "entry",
                id: "e1",
                parentId: null,
                seq: 1,
                timestamp: 1_000,
                type: "message",
                message: { role: "user", content: [{ type: "text", text: "hi" }] },
            })}\n${JSON.stringify({
                kind: "entry",
                id: "e2",
                parentId: "e1",
                seq: 2,
                timestamp: 9_000,
                type: "compaction",
                summary: "x",
            })}\n`,
        );
        const { activityAt } = await readSessionMetadataFromDisk(path);
        assert.equal(activityAt, 1_000);
    });

    it("takes the max message timestamp when records are out of order", async () => {
        const path = tmpFile(
            `${JSON.stringify({
                v: 4,
                kind: "header",
                id: "s1",
                createdAt: 1,
                storageVersion: 1,
                cwd: "/ws",
            })}\n${JSON.stringify({
                kind: "entry",
                id: "e2",
                parentId: "e1",
                seq: 2,
                timestamp: 5_000,
                type: "message",
                message: { role: "assistant", content: [{ type: "text", text: "later" }] },
            })}\n${JSON.stringify({
                kind: "entry",
                id: "e1",
                parentId: null,
                seq: 1,
                timestamp: 1_000,
                type: "message",
                message: { role: "user", content: [{ type: "text", text: "earlier" }] },
            })}\n`,
        );
        const { activityAt } = await readSessionMetadataFromDisk(path);
        assert.equal(activityAt, 5_000);
    });

    it("returns undefined activityAt when the file has no messages", async () => {
        const path = tmpFile(
            `${JSON.stringify({
                v: 4,
                kind: "header",
                id: "s1",
                createdAt: 1,
                storageVersion: 1,
                cwd: "/ws",
            })}\n`,
        );
        const { activityAt } = await readSessionMetadataFromDisk(path);
        assert.equal(activityAt, undefined);
    });
});

describe("readLegacyFactsFromPath", () => {
    const dirs: string[] = [];
    afterEach(() => {
        for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
        dirs.length = 0;
    });

    function tmpFile(contents: string): string {
        const dir = mkdtempSync(join(tmpdir(), "taco-legacy-"));
        dirs.push(dir);
        const path = join(dir, "session.jsonl");
        writeFileSync(path, contents);
        return path;
    }

    it("returns v3 bag facts and ignores a v4 file", async () => {
        const v3 = tmpFile(
            `${JSON.stringify({
                type: "session",
                version: 3,
                id: "s1",
                timestamp: "2026-08-13T16:17:40.770Z",
                cwd: "/ws",
                metadata: { kind: "subagent", parentSessionId: "parent-1" },
            })}\n`,
        );
        const v4 = tmpFile(
            `${JSON.stringify({
                v: 4,
                kind: "header",
                id: "s1",
                createdAt: 1,
                storageVersion: 1,
                cwd: "/ws",
            })}\n`,
        );
        const recovered = await readLegacyFactsFromPath(v3);
        assert.equal(recovered?.kind, "subagent");
        assert.equal(recovered?.parentSessionId, "parent-1");
        assert.equal(await readLegacyFactsFromPath(v4), undefined);
    });

    it("returns undefined for a missing file rather than throwing", async () => {
        assert.equal(
            await readLegacyFactsFromPath(join(tmpdir(), "no-such-session.jsonl")),
            undefined,
        );
    });
});
