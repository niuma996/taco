/**
 * SessionFacts helpers — hide-from-list classification, the write-if-absent
 * guard used when restoring a v3 metadata bag, and the JSONL header/facts
 * scanner shared by both paths.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { harnessContext } from "../../src/lib/harnessContext.ts";
import { NodeExecutionEnv } from "../../src/runtime/pi/node.ts";
import { JsonlSessionRepo, uuidv7 } from "../../src/runtime/pi/values.ts";
import {
    isHiddenSubagentSession,
    resolveParentDepth,
    SESSION_FACTS_NAMESPACE,
    type SessionFacts,
    writeSessionFacts,
} from "../../src/runtime/session/sessionFacts.ts";
import {
    parseLegacyV3TacoMetadata,
    parseSessionFileHeader,
    readLegacyFactsFromPath,
    readSessionMetadataFromDisk,
} from "../../src/runtime/session/sessionMetadataReader.ts";

describe("isHiddenSubagentSession", () => {
    it("hides only when a parent shows up somewhere", () => {
        // The create→writeSessionFacts window: the file exists, facts are
        // still {}, but repo.create already stamped parentSessionId.
        //
        // Restored v3 metadata, or a facts write that recorded the parent
        // before kind made it onto disk.
        //
        // kind:main is the user-session marker. A header parent without
        // kind:subagent would be a fork, which sidecar does not currently
        // expose, but the kind flag must still win so a future fork path
        // cannot hide a labelled main session.
        const cases: Array<{
            label: string;
            facts: SessionFacts;
            headerParentSessionId?: string;
            hidden: boolean;
        }> = [
            { label: "explicit subagent fact", facts: { kind: "subagent" }, hidden: true },
            {
                label: "explicit subagent fact + header parent",
                facts: { kind: "subagent" },
                headerParentSessionId: "parent-id",
                hidden: true,
            },
            {
                label: "labelled main + header parent",
                facts: { kind: "main" },
                headerParentSessionId: "parent-id",
                hidden: false,
            },
            { label: "labelled main", facts: { kind: "main" }, hidden: false },
            {
                label: "header parentSessionId with kind absent",
                facts: {},
                headerParentSessionId: "parent-id",
                hidden: true,
            },
            {
                label: "facts parentSessionId with kind absent",
                facts: { parentSessionId: "parent-id" },
                hidden: true,
            },
            { label: "no parent anywhere — legacy user session", facts: {}, hidden: false },
            { label: "agentType only", facts: { agentType: "explorer" }, hidden: false },
        ];
        for (const { label, facts, headerParentSessionId, hidden } of cases) {
            assert.equal(isHiddenSubagentSession(facts, headerParentSessionId), hidden, label);
        }
    });
});

describe("resolveParentDepth", () => {
    it("returns the stored depth when present", () => {
        assert.equal(resolveParentDepth({ depth: 2 }, {}), 2);
        assert.equal(resolveParentDepth({ kind: "subagent", depth: 1 }, {}), 1);
    });

    it("defaults a facts-less user session to 0 without treating it as broken", () => {
        // Main sessions never write taco.session.facts. Spawning from one
        // must be depth 0, not a warning-worthy failure.
        assert.equal(resolveParentDepth({}, { parentSessionId: "main" }), 0);
        assert.equal(resolveParentDepth({ kind: "main" }, {}), 0);
    });

    it("defaults a subagent-looking parent with no depth to 0", () => {
        assert.equal(resolveParentDepth({ kind: "subagent" }, {}), 0);
        assert.equal(resolveParentDepth({ parentSessionId: "p" }, {}), 0);
    });
});

describe("writeSessionFacts / scanner contract", () => {
    const dirs: string[] = [];
    afterEach(() => {
        for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
        dirs.length = 0;
    });

    it("is the namespace writeSessionFacts persists and the scanner reads", async () => {
        const cwd = mkdtempSync(join(tmpdir(), "taco-facts-cwd-"));
        const sessionsRoot = mkdtempSync(join(tmpdir(), "taco-facts-sessions-"));
        dirs.push(cwd, sessionsRoot);
        const env = new NodeExecutionEnv({ cwd });
        const repo = new JsonlSessionRepo({ fileSystem: env, sessionsRoot });
        const id = uuidv7();
        const session = await repo.create({ id, cwd }, harnessContext);
        const path = session.metadata.path;
        await writeSessionFacts(session, {
            kind: "subagent",
            agentType: "explorer",
            depth: 1,
            parentSessionId: "parent-1",
        });
        await session.close(harnessContext);

        const { facts } = await readSessionMetadataFromDisk(path);
        assert.equal(facts.kind, "subagent");
        assert.equal(facts.agentType, "explorer");
        assert.equal(facts.depth, 1);
        assert.equal(facts.parentSessionId, "parent-1");
    });
});

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
