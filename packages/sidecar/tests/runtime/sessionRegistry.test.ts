/**
 * SessionRegistry — covers session CRUD + cache lifecycle.
 *
 * attach / detach requires a fully-configured Provider stub to drive
 * AttachedSession.create → AgentHarness — end-to-end scope; here we cover
 * the pure data paths: list / open / rename / getSessionName / getHistory /
 * delete / cache invalidation. attach is exercised via the workspace.subagent
 * facade test and the methods.sessionCreate end-to-end test.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createSessionId, JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createModels } from "@earendil-works/pi-ai/compat";
import type { WorkspaceId } from "@taco-ai/protocol";
import { SessionRegistry, type SessionRegistryOptions } from "../../src/runtime/sessionRegistry.ts";
import type { SessionTaskState } from "../../src/runtime/sessionTaskState.ts";

const fakeTool = (name: string): AgentTool =>
    ({ name, description: "fake", execute: async () => ({ text: "" }) }) as unknown as AgentTool;

let cwd: string;
let sessionsRoot: string;
let repo: JsonlSessionRepo;
let env: NodeExecutionEnv;
let models: ReturnType<typeof createModels>;

beforeEach(() => {
    // Each test gets a fresh cwd + sessionsRoot so session counts are deterministic.
    cwd = mkdtempSync(join(tmpdir(), "taco-sr-cwd-"));
    sessionsRoot = mkdtempSync(join(tmpdir(), "taco-sr-sessions-"));
    env = new NodeExecutionEnv({ cwd });
    repo = new JsonlSessionRepo({ fs: env, sessionsRoot });
    models = createModels();
});

afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(sessionsRoot, { recursive: true, force: true });
});

function makeRegistry(overrides: Partial<SessionRegistryOptions> = {}): SessionRegistry {
    return new SessionRegistry({
        cwd: cwd as WorkspaceId,
        repo,
        sessionsRoot,
        env,
        models,
        // defaultModel left undefined — attach tests are out of scope here
        systemPrompt: "test prompt",
        tools: [fakeTool("fake-tool")],
        resources: {},
        streamOptions: {},
        spawnSubagent: async () => ({
            subSessionId: "stub-sub",
            resultText: "",
            isError: true,
        }),
        resumeSubagent: async () => ({
            subSessionId: "stub-sub",
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
        // Test stubs return a self-RPC-less context: tools that need call/actor
        // are tested separately (see tools/memory.test.ts, tools/jobs.test.ts).
        getToolContext: () => ({ env, workspace: cwd as WorkspaceId }),
        ...overrides,
    });
}

describe("SessionRegistry", () => {
    it("listSessions returns empty array on fresh workspace", async () => {
        const sr = makeRegistry();
        const list = await sr.listSessions();
        assert.equal(list.length, 0);
    });

    it("listSessions caches — second call does not hit repo again", async () => {
        const sr = makeRegistry();
        await sr.repo.create({ id: createSessionId(), cwd });
        sr.invalidateListCache();
        const first = await sr.listSessions();
        assert.equal(first.length, 1);
        // Add another session directly to repo without invalidating cache.
        await sr.repo.create({ id: createSessionId(), cwd });
        const second = await sr.listSessions();
        // Cache hit — same length as first call.
        assert.equal(second.length, 1);
        assert.equal(second, first); // same reference
    });

    it("invalidateListCache forces next listSessions to re-read", async () => {
        const sr = makeRegistry();
        await sr.repo.create({ id: createSessionId(), cwd });
        sr.invalidateListCache();
        const first = await sr.listSessions();
        assert.equal(first.length, 1);
        await sr.repo.create({ id: createSessionId(), cwd });
        sr.invalidateListCache();
        const second = await sr.listSessions();
        assert.equal(second.length, 2);
    });

    it("openSession throws when session not found", async () => {
        const sr = makeRegistry();
        await assert.rejects(() => sr.openSession("nonexistent"), /session not found/);
    });

    it("openSession finds by exact id and by prefix", async () => {
        const sr = makeRegistry();
        const id = createSessionId();
        await sr.repo.create({ id, cwd });
        sr.invalidateListCache();
        const exact = await sr.openSession(id);
        assert.equal(exact.id, id);
        const prefix = await sr.openSession(id.slice(0, 8));
        assert.equal(prefix.id, id);
    });

    it("rename + getSessionName round-trip via cache", async () => {
        const sr = makeRegistry();
        const id = createSessionId();
        await sr.repo.create({ id, cwd });
        sr.invalidateListCache();
        await sr.renameSession(id, "my-session");
        const name = await sr.getSessionName(id);
        assert.equal(name, "my-session");
    });

    // The round-trip above is answered from _nameCache (renameSession populates
    // it), so it never exercises the disk read. getSessionName streams the
    // JSONL instead of building a full JsonlSessionStorage, and a rename
    // appends a second session_info rather than rewriting the first — so
    // "last one wins" has to hold against the file, not the cache.
    it("getSessionName reads the newest session_info from disk on a cold cache", async () => {
        const sr = makeRegistry();
        const id = createSessionId();
        await sr.repo.create({ id, cwd });
        sr.invalidateListCache();
        await sr.renameSession(id, "first-title");
        await sr.renameSession(id, "second-title");
        // Drop _nameCache so the answer must come from the file.
        sr.invalidateListCache();
        assert.equal(await sr.getSessionName(id), "second-title");
    });

    it("getSessionName returns undefined for a session that was never titled", async () => {
        const sr = makeRegistry();
        const id = createSessionId();
        await sr.repo.create({ id, cwd });
        sr.invalidateListCache();
        assert.equal(await sr.getSessionName(id), undefined);
    });

    it("rename updates _nameCache precisely without invalidating list cache", async () => {
        const sr = makeRegistry();
        const id = createSessionId();
        await sr.repo.create({ id, cwd });
        sr.invalidateListCache();
        const before = await sr.listSessions();
        await sr.renameSession(id, "renamed");
        const after = await sr.listSessions();
        assert.equal(after, before); // cache not invalidated
    });

    it("getHistory returns empty entries for fresh session", async () => {
        const sr = makeRegistry();
        const id = createSessionId();
        await sr.repo.create({ id, cwd });
        sr.invalidateListCache();
        const { entries, leafEntryId } = await sr.getHistory(id);
        assert.equal(entries.length, 0);
        assert.equal(leafEntryId, null);
    });

    it("deleteSession removes from list and emits session.deleted", async () => {
        const sr = makeRegistry();
        const id = createSessionId();
        await sr.repo.create({ id, cwd });
        sr.invalidateListCache();
        let deleted: string | undefined;
        sr.on("session.deleted", (e: { sessionId: string }) => {
            deleted = e.sessionId;
        });
        await sr.deleteSession(id);
        assert.equal(deleted, id);
        const list = await sr.listSessions();
        assert.equal(list.length, 0);
    });

    it("getAttached returns undefined for unattached session", () => {
        const sr = makeRegistry();
        assert.equal(sr.getAttached("never-attached"), undefined);
    });

    it("getSessionKind returns 'main' for unknown session (default)", () => {
        const sr = makeRegistry();
        assert.equal(sr.getSessionKind("never-attached"), "main");
    });

    it("dispose does not throw on empty registry", async () => {
        const sr = makeRegistry();
        await sr.dispose();
    });

    it("toolsForChildSession returns the same taskState the tools were built from", async () => {
        const id = createSessionId();
        await repo.create({ id, cwd });
        let seenByBuilder: SessionTaskState | undefined;
        const sr = makeRegistry({
            toolsBuilder: (_sid, taskState) => {
                seenByBuilder = taskState;
                return [fakeTool("fake-tool")];
            },
        });
        const { tools, taskState } = await sr.toolsForChildSession(id);
        // The returned taskState must be the one whose store the tools close over —
        // otherwise attachChild builds a second independent TaskStore and the
        // tools' writes diverge from attached.taskStore.
        assert.ok(seenByBuilder, "toolsBuilder should have been called");
        assert.equal(tools.length, 1);
        assert.equal(taskState, seenByBuilder);
        assert.equal(taskState.taskStore, seenByBuilder.taskStore);

        // Reference equality alone would still pass if a later refactor handed
        // back a shallow copy, so assert the stores actually share state: a write
        // through the builder's handle must be visible on the returned one.
        // This is the mutation path the original bug lost.
        seenByBuilder.taskStore.lists.set("list-1", {
            id: "list-1",
            name: "shared",
            tasks: [],
            metadata: { nextTaskId: 1 },
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
        });
        assert.equal(taskState.taskStore.lists.get("list-1")?.name, "shared");
    });
});
