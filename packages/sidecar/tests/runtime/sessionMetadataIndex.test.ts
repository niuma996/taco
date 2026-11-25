/**
 * Session metadata index — the disk-backed copy of SessionRegistry's scan
 * caches. Covers the file format (round-trip, corruption, pruning) and the
 * registry trust decision: an entry whose recorded mtime matches the session
 * file is served without rescanning; any mismatch falls back to the scan.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createModels } from "@earendil-works/pi-ai/compat";
import { asSessionId, type SessionId, type WorkspaceId } from "@taco-ai/protocol";
import { harnessContext } from "../../src/lib/harnessContext.ts";
import { NodeExecutionEnv } from "../../src/runtime/pi/node.ts";
import { JsonlSessionRepo, uuidv7 } from "../../src/runtime/pi/values.ts";
import {
    loadSessionMetadataIndex,
    type PersistedSessionMetadata,
    saveSessionMetadataIndex,
    sessionMetadataIndexPath,
} from "../../src/runtime/session/sessionMetadataIndex.ts";
import {
    SessionRegistry,
    type SessionRegistryOptions,
} from "../../src/runtime/session/sessionRegistry.ts";
import type { TacoTool } from "../../src/tools/index.ts";

const fakeTool = (name: string): TacoTool =>
    ({
        name,
        label: name,
        description: "fake",
        parameters: {},
        async execute() {
            return { content: [{ type: "text", text: "" }], details: {} };
        },
    }) as unknown as TacoTool;

function makeEntry(overrides: Partial<PersistedSessionMetadata> = {}): PersistedSessionMetadata {
    return {
        name: "from-index",
        facts: { kind: "subagent" },
        activityAt: 1_700_000_000_000,
        titleSource: "user",
        messageCount: 42,
        modifiedAt: 0,
        ...overrides,
    };
}

describe("sessionMetadataIndex file format", () => {
    let dir: string;
    let path: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "taco-smi-"));
        path = sessionMetadataIndexPath(dir, "/some/workspace");
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it("round-trips entries through save and load", async () => {
        const entries = new Map<SessionId, PersistedSessionMetadata>([
            [asSessionId("a"), makeEntry({ modifiedAt: 100 })],
            [
                asSessionId("b"),
                makeEntry({ name: undefined, activityAt: undefined, modifiedAt: 200 }),
            ],
        ]);
        await saveSessionMetadataIndex(path, entries);
        const loaded = await loadSessionMetadataIndex(path);
        assert.equal(loaded.size, 2);
        assert.deepEqual(loaded.get(asSessionId("a")), entries.get(asSessionId("a")));
        // JSON drops undefined-valued keys; the loader must read the entry
        // back as absent fields, matching how a cache miss is represented.
        assert.deepEqual(loaded.get(asSessionId("b")), {
            facts: { kind: "subagent" },
            titleSource: "user",
            messageCount: 42,
            modifiedAt: 200,
        });
    });

    it("keeps index files of different workspaces apart under one root", () => {
        const a = sessionMetadataIndexPath(dir, "/work/one");
        const b = sessionMetadataIndexPath(dir, "/work/two");
        assert.notEqual(a, b);
        assert.equal(sessionMetadataIndexPath(dir, "/work/one"), a);
    });

    it("treats a missing or corrupted file as empty", async () => {
        assert.equal((await loadSessionMetadataIndex(path)).size, 0);
        const { mkdirSync } = await import("node:fs");
        mkdirSync(join(dir, ".taco-metadata-index"), { recursive: true });
        writeFileSync(path, "not json{");
        assert.equal((await loadSessionMetadataIndex(path)).size, 0);
        writeFileSync(path, JSON.stringify({ version: 999, entries: { a: makeEntry() } }));
        assert.equal((await loadSessionMetadataIndex(path)).size, 0);
    });

    it("prunes entries outside keepIds on save", async () => {
        const entries = new Map<SessionId, PersistedSessionMetadata>([
            [asSessionId("kept"), makeEntry({ modifiedAt: 1 })],
            [asSessionId("deleted"), makeEntry({ modifiedAt: 2 })],
        ]);
        await saveSessionMetadataIndex(path, entries, new Set(["kept"]));
        const loaded = await loadSessionMetadataIndex(path);
        assert.deepEqual([...loaded.keys()], ["kept"]);
    });
});

describe("SessionRegistry metadata index trust", () => {
    let cwd: string;
    let sessionsRoot: string;
    let repo: JsonlSessionRepo;
    let env: NodeExecutionEnv;

    function makeRegistry(overrides: Partial<SessionRegistryOptions> = {}): SessionRegistry {
        return new SessionRegistry({
            cwd: cwd as WorkspaceId,
            repo,
            sessionsRoot,
            env,
            models: createModels(),
            getSystemPrompt: () => "test prompt",
            tools: [fakeTool("fake-tool")],
            resources: {},
            streamOptions: {},
            spawnSubagent: async () => ({
                subSessionId: asSessionId("stub-sub"),
                resultText: "",
                isError: true,
            }),
            spawnSkillSubagent: async () => ({
                subSessionId: "stub-sub",
                resultText: "",
                isError: true,
            }),
            availableAgentTypes: [],
            skills: [],
            getToolContext: () => ({ env, workspace: cwd as WorkspaceId }),
            ...overrides,
        });
    }

    /** Create a real (header-only) session file and return its list metadata. */
    async function seedSession(id: SessionId) {
        const session = await repo.create({ id, cwd }, harnessContext);
        await session.close(harnessContext);
        const list = await repo.list({ cwd }, harnessContext);
        const meta = list.find((m) => m.id === id);
        assert.ok(meta, "seeded session should appear in repo.list");
        return meta;
    }

    beforeEach(() => {
        cwd = mkdtempSync(join(tmpdir(), "taco-smi-cwd-"));
        sessionsRoot = mkdtempSync(join(tmpdir(), "taco-smi-sessions-"));
        env = new NodeExecutionEnv({ cwd });
        repo = new JsonlSessionRepo({ fileSystem: env, sessionsRoot });
    });

    afterEach(() => {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(sessionsRoot, { recursive: true, force: true });
    });

    it("serves an mtime-current index entry without rescanning the file", async () => {
        const id = asSessionId(uuidv7());
        const meta = await seedSession(id);
        // The real file is header-only: no name, no facts, zero messages. An
        // index entry carrying made-up values with the file's current mtime
        // must win — anything else means the scan ran.
        const index = new Map<SessionId, PersistedSessionMetadata>([
            [id, makeEntry({ modifiedAt: meta.modifiedAt })],
        ]);
        await saveSessionMetadataIndex(sessionMetadataIndexPath(sessionsRoot, cwd), index);

        const sr = makeRegistry();
        assert.equal(await sr.getSessionName(id), "from-index");
        assert.deepEqual(await sr.getSessionFacts(id), { kind: "subagent" });
        assert.equal(await sr.getSessionMessageCount(id), 42);
    });

    it("rescans when the recorded mtime is stale", async () => {
        const id = asSessionId(uuidv7());
        const meta = await seedSession(id);
        const index = new Map<SessionId, PersistedSessionMetadata>([
            [id, makeEntry({ modifiedAt: meta.modifiedAt - 1000 })],
        ]);
        await saveSessionMetadataIndex(sessionMetadataIndexPath(sessionsRoot, cwd), index);

        const sr = makeRegistry();
        assert.equal(await sr.getSessionName(id), undefined);
        assert.deepEqual(await sr.getSessionFacts(id), {});
        assert.equal(await sr.getSessionMessageCount(id), 0);
    });

    it("persists scan results for the next cold daemon", async () => {
        const id = asSessionId(uuidv7());
        const meta = await seedSession(id);
        const sr = makeRegistry();
        assert.equal(await sr.getSessionMessageCount(id), 0);

        // The save is debounced (250ms); wait it out, then the file must hold
        // this session keyed by the mtime the scan saw.
        await new Promise((r) => setTimeout(r, 700));
        const loaded = await loadSessionMetadataIndex(sessionMetadataIndexPath(sessionsRoot, cwd));
        const entry = loaded.get(id);
        assert.ok(entry, "scan should have been persisted");
        assert.equal(entry.modifiedAt, meta.modifiedAt);
        assert.equal((await stat(meta.path)).mtimeMs, entry.modifiedAt);
    });
});
