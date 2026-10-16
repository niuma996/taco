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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createModels } from "@earendil-works/pi-ai/compat";
import { asSessionId, type WorkspaceId } from "@taco-ai/protocol";
import { harnessContext } from "../../src/lib/harnessContext.ts";
import { NodeExecutionEnv } from "../../src/runtime/pi/node.ts";
import { JsonlSessionRepo, uuidv7 } from "../../src/runtime/pi/values.ts";
import { readSessionFacts, writeSessionFacts } from "../../src/runtime/session/sessionFacts.ts";
import { SessionNotFoundError } from "../../src/runtime/session/sessionLookup.ts";
import {
    SessionRegistry,
    type SessionRegistryOptions,
} from "../../src/runtime/session/sessionRegistry.ts";
import type { SessionTaskState } from "../../src/runtime/session/sessionTaskState.ts";
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
    repo = new JsonlSessionRepo({ fileSystem: env, sessionsRoot });
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
        getSystemPrompt: () => "test prompt",
        tools: [fakeTool("fake-tool")],
        resources: {},
        streamOptions: {},
        spawnSubagent: async () => ({
            subSessionId: asSessionId("stub-sub"),
            resultText: "",
            isError: true,
        }),
        resumeSubagent: async () => ({
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
        // Test stubs return a self-RPC-less context: tools that need call/actor
        // are tested separately (see tools/memory.test.ts, tools/jobs.test.ts).
        getToolContext: () => ({ env, workspace: cwd as WorkspaceId }),
        ...overrides,
    });
}

/**
 * Create a session on disk and release it.
 *
 * `repo.create()` returns an *open* session and pi 0.85 rejects a second open
 * of the same id, so a fixture that only wants the file to exist must close
 * its handle or every later read/attach in the test fails.
 */
async function seedSession(target: JsonlSessionRepo, id: string): Promise<void> {
    const session = await target.create({ id, cwd }, harnessContext);
    await session.close(harnessContext);
}

describe("SessionRegistry", () => {
    it("listSessions returns empty array on fresh workspace", async () => {
        const sr = makeRegistry();
        const list = await sr.listSessions();
        assert.equal(list.length, 0);
    });

    it("listSessions caches — second call does not hit repo again", async () => {
        const sr = makeRegistry();
        await seedSession(sr.repo, uuidv7());
        sr.invalidateListCache();
        const first = await sr.listSessions();
        assert.equal(first.length, 1);
        // Add another session directly to repo without invalidating cache.
        await seedSession(sr.repo, uuidv7());
        const second = await sr.listSessions();
        // Cache hit — same length as first call.
        assert.equal(second.length, 1);
        assert.equal(second, first); // same reference
    });

    it("invalidateListCache forces next listSessions to re-read", async () => {
        const sr = makeRegistry();
        await seedSession(sr.repo, uuidv7());
        sr.invalidateListCache();
        const first = await sr.listSessions();
        assert.equal(first.length, 1);
        await seedSession(sr.repo, uuidv7());
        sr.invalidateListCache();
        const second = await sr.listSessions();
        assert.equal(second.length, 2);
    });

    it("openSession throws a plain Error, not SessionNotFoundError, on an empty list", async () => {
        // An empty list is indistinguishable from a transient repo.list
        // failure; clients prune sidebar rows on SessionNotFoundError.
        const sr = makeRegistry();
        await assert.rejects(
            () => sr.openSession(asSessionId("nonexistent")),
            (e: unknown) =>
                e instanceof Error &&
                !(e instanceof SessionNotFoundError) &&
                /session not found/.test(e.message),
        );
    });

    it("openSession throws SessionNotFoundError when a non-empty list lacks the id", async () => {
        const sr = makeRegistry();
        await seedSession(sr.repo, uuidv7());
        sr.invalidateListCache();
        await assert.rejects(
            () => sr.openSession(asSessionId("nonexistent")),
            SessionNotFoundError,
        );
    });

    it("openSession re-reads a stale cache before declaring a miss", async () => {
        const sr = makeRegistry();
        await seedSession(sr.repo, uuidv7());
        sr.invalidateListCache();
        await sr.listSessions();
        // Created behind the cache's back, as another writer would.
        const late = uuidv7();
        await seedSession(sr.repo, late);
        const meta = await sr.openSession(asSessionId(late));
        assert.equal(meta.id, late);
    });

    it("openSession finds by exact id and by prefix", async () => {
        const sr = makeRegistry();
        const id = uuidv7();
        await seedSession(sr.repo, id);
        sr.invalidateListCache();
        const exact = await sr.openSession(asSessionId(id));
        assert.equal(exact.id, id);
        const prefix = await sr.openSession(asSessionId(id.slice(0, 8)));
        assert.equal(prefix.id, id);
    });

    it("openSession rejects a prefix that matches more than one session", async () => {
        const sr = makeRegistry();
        // Two ids sharing an 8-char prefix — this is the collision
        // resolveSessionByPrefix has to report rather than silently resolve.
        const shared = uuidv7().slice(0, 8);
        const idA = `${shared}${uuidv7().slice(8)}`;
        const idB = `${shared}${uuidv7().slice(8)}`;
        await seedSession(sr.repo, idA);
        await seedSession(sr.repo, idB);
        sr.invalidateListCache();
        await assert.rejects(
            () => sr.openSession(asSessionId(shared)),
            /session id prefix is ambiguous/,
        );
    });

    // A rename populates _nameCache, so a rename→getSessionName round-trip is
    // answered from the cache and never exercises the disk read.
    // getSessionName streams the JSONL instead of building a full
    // JsonlSessionStorage, and a rename appends a second session_info rather than
    // rewriting the first — so "last one wins" has to hold against the file, not
    // the cache.
    it("getSessionName reads the newest session_info from disk on a cold cache", async () => {
        const sr = makeRegistry();
        const id = uuidv7();
        await seedSession(sr.repo, id);
        sr.invalidateListCache();
        await sr.renameSession(asSessionId(id), "first-title");
        await sr.renameSession(asSessionId(id), "second-title");
        // Drop _nameCache so the answer must come from the file.
        sr.invalidateListCache();
        assert.equal(await sr.getSessionName(asSessionId(id)), "second-title");
    });

    it("getSessionName returns undefined for a session that was never titled", async () => {
        const sr = makeRegistry();
        const id = uuidv7();
        await seedSession(sr.repo, id);
        sr.invalidateListCache();
        assert.equal(await sr.getSessionName(asSessionId(id)), undefined);
    });

    // pi commits a multi-write batch as a JSON array on one line. Only runtime
    // state is batched today, so a name written that way is hypothetical — but
    // the scanner used to read the object shape only, which meant an array line
    // parsed to something whose `.kind` was undefined and was skipped, dropping
    // the title with no error. Append a batched name write directly and require
    // the scan to see it.
    it("getSessionName reads a name committed inside a batched array line", async () => {
        const sr = makeRegistry();
        const id = uuidv7();
        await seedSession(sr.repo, id);
        sr.invalidateListCache();
        const meta = await sr.openSession(asSessionId(id));
        // Mirror pi's on-disk value-record shape; `seq` only has to be past the
        // seeded entries for "last write wins" to select it.
        await appendFile(
            meta.path,
            `${JSON.stringify([
                {
                    kind: "value",
                    op: "set",
                    seq: 9001,
                    namespace: "pi.branch.tip",
                    key: "main",
                    value: "x",
                },
                {
                    kind: "value",
                    op: "set",
                    seq: 9002,
                    namespace: "pi.session.name",
                    key: "",
                    value: "batched-title",
                },
            ])}\n`,
        );
        sr.invalidateListCache();
        assert.equal(await sr.getSessionName(asSessionId(id)), "batched-title");
    });

    it("rename updates _nameCache precisely without invalidating list cache", async () => {
        const sr = makeRegistry();
        const id = uuidv7();
        await seedSession(sr.repo, id);
        sr.invalidateListCache();
        const before = await sr.listSessions();
        await sr.renameSession(asSessionId(id), "renamed");
        const after = await sr.listSessions();
        assert.equal(after, before); // cache not invalidated
    });

    it("renameSession marks the title as user-owned", async () => {
        const sr = makeRegistry();
        const id = uuidv7();
        await seedSession(sr.repo, id);
        sr.invalidateListCache();
        await sr.renameSession(asSessionId(id), "my-session");
        assert.equal(await sr.getTitleSource(asSessionId(id)), "user");
    });

    it("setPlaceholderTitle writes the title and marks it placeholder-owned on a fresh session", async () => {
        const sr = makeRegistry();
        const id = uuidv7();
        await seedSession(sr.repo, id);
        sr.invalidateListCache();
        const wrote = await sr.setPlaceholderTitle(asSessionId(id), "placeholder title");
        assert.equal(wrote, true);
        assert.equal(await sr.getSessionName(asSessionId(id)), "placeholder title");
        assert.equal(await sr.getTitleSource(asSessionId(id)), "placeholder");
    });

    // This is the core guarantee the feature exists for: a follow-up prompt's
    // truncation-placeholder call must not clobber a name the user just chose
    // via the rename modal.
    it("setPlaceholderTitle is a no-op once the session has been user-renamed", async () => {
        const sr = makeRegistry();
        const id = uuidv7();
        await seedSession(sr.repo, id);
        sr.invalidateListCache();
        await sr.renameSession(asSessionId(id), "user chosen");
        const wrote = await sr.setPlaceholderTitle(asSessionId(id), "next message truncated...");
        assert.equal(wrote, false);
        assert.equal(await sr.getSessionName(asSessionId(id)), "user chosen");
        assert.equal(await sr.getTitleSource(asSessionId(id)), "user");
    });

    // A user rename that lands *between* two setPlaceholderTitle calls (the
    // session.prompt placeholder path) must stick — later placeholders must
    // keep deferring to it, not just the one immediately before the rename.
    it("setPlaceholderTitle stays a no-op across multiple calls after a user rename", async () => {
        const sr = makeRegistry();
        const id = uuidv7();
        await seedSession(sr.repo, id);
        sr.invalidateListCache();
        await sr.setPlaceholderTitle(asSessionId(id), "first message truncated");
        await sr.renameSession(asSessionId(id), "user chosen");
        await sr.setPlaceholderTitle(asSessionId(id), "second message truncated");
        await sr.setPlaceholderTitle(asSessionId(id), "third message truncated");
        assert.equal(await sr.getSessionName(asSessionId(id)), "user chosen");
    });

    // A session titled before this feature shipped has no titleSource record
    // at all. Treat that the same as owned-by-someone-else — an untagged
    // title must not be silently overwritten by the next placeholder write.
    it("setPlaceholderTitle is a no-op on a pre-existing name with no recorded titleSource", async () => {
        const sr = makeRegistry();
        const id = uuidv7();
        const created = await sr.repo.create({ id, cwd }, harnessContext);
        await created.setName("legacy title", harnessContext);
        await created.close(harnessContext);
        sr.invalidateListCache();

        assert.equal(await sr.getTitleSource(asSessionId(id)), undefined);
        const wrote = await sr.setPlaceholderTitle(asSessionId(id), "placeholder title");
        assert.equal(wrote, false);
        assert.equal(await sr.getSessionName(asSessionId(id)), "legacy title");
    });

    // The summary path takes the opposite call on the same state: an untagged
    // title is not a user rename, and a summary is strictly better than
    // whatever truncation left it there. Only a recorded "user" source blocks.
    it("setSummaryTitle overwrites a pre-existing name with no recorded titleSource", async () => {
        const sr = makeRegistry();
        const id = uuidv7();
        const created = await sr.repo.create({ id, cwd }, harnessContext);
        await created.setName("legacy title", harnessContext);
        await created.close(harnessContext);
        sr.invalidateListCache();

        assert.equal(await sr.getTitleSource(asSessionId(id)), undefined);
        const wrote = await sr.setSummaryTitle(asSessionId(id), "LLM summary");
        assert.equal(wrote, true);
        assert.equal(await sr.getSessionName(asSessionId(id)), "LLM summary");
        assert.equal(await sr.getTitleSource(asSessionId(id)), "summary");
    });

    it("getTitleSource reads the newest value from disk on a cold cache", async () => {
        const sr = makeRegistry();
        const id = uuidv7();
        await seedSession(sr.repo, id);
        sr.invalidateListCache();
        await sr.setPlaceholderTitle(asSessionId(id), "placeholder title");
        await sr.renameSession(asSessionId(id), "user title");
        sr.invalidateListCache();
        assert.equal(await sr.getTitleSource(asSessionId(id)), "user");
    });

    it("setSummaryTitle replaces a placeholder title and marks it summary-owned", async () => {
        const sr = makeRegistry();
        const id = uuidv7();
        await seedSession(sr.repo, id);
        sr.invalidateListCache();
        await sr.setPlaceholderTitle(asSessionId(id), "placeholder title");
        const wrote = await sr.setSummaryTitle(asSessionId(id), "Fix login redirect bug");
        assert.equal(wrote, true);
        assert.equal(await sr.getSessionName(asSessionId(id)), "Fix login redirect bug");
        assert.equal(await sr.getTitleSource(asSessionId(id)), "summary");
    });

    it("setSummaryTitle writes on a never-titled session (never-titled ≠ owned)", async () => {
        const sr = makeRegistry();
        const id = uuidv7();
        await seedSession(sr.repo, id);
        sr.invalidateListCache();
        const wrote = await sr.setSummaryTitle(asSessionId(id), "Fix login redirect bug");
        assert.equal(wrote, true);
        assert.equal(await sr.getTitleSource(asSessionId(id)), "summary");
    });

    // Core guarantee: every completed run_end re-derives the title, so a later
    // summary replaces an earlier one. A title from the opening message stops
    // describing a conversation that has moved on.
    it("setSummaryTitle replaces an earlier summary", async () => {
        const sr = makeRegistry();
        const id = uuidv7();
        await seedSession(sr.repo, id);
        sr.invalidateListCache();
        await sr.setSummaryTitle(asSessionId(id), "first summary");
        const wrote = await sr.setSummaryTitle(asSessionId(id), "second summary");
        assert.equal(wrote, true);
        assert.equal(await sr.getSessionName(asSessionId(id)), "second summary");
    });

    // The dedupe guard in writeTitle: re-summarizing a conversation whose topic
    // has not moved must not append a record or fire a session.renamed push.
    it("setSummaryTitle short-circuits when the derived title is unchanged", async () => {
        const sr = makeRegistry();
        const id = uuidv7();
        await seedSession(sr.repo, id);
        sr.invalidateListCache();
        await sr.setSummaryTitle(asSessionId(id), "same topic");
        const wrote = await sr.setSummaryTitle(asSessionId(id), "same topic");
        assert.equal(wrote, false);
        assert.equal(await sr.getSessionName(asSessionId(id)), "same topic");
    });

    it("setSummaryTitle is a no-op once the session has been user-renamed", async () => {
        const sr = makeRegistry();
        const id = uuidv7();
        await seedSession(sr.repo, id);
        sr.invalidateListCache();
        await sr.renameSession(asSessionId(id), "user chosen");
        const wrote = await sr.setSummaryTitle(asSessionId(id), "LLM summary");
        assert.equal(wrote, false);
        assert.equal(await sr.getSessionName(asSessionId(id)), "user chosen");
    });

    // A summary must win over a subsequent placeholder write too — a real
    // summary is strictly better than a truncation of the next message.
    it("setPlaceholderTitle is a no-op once the session has a summary", async () => {
        const sr = makeRegistry();
        const id = uuidv7();
        await seedSession(sr.repo, id);
        sr.invalidateListCache();
        await sr.setPlaceholderTitle(asSessionId(id), "first message truncated");
        await sr.setSummaryTitle(asSessionId(id), "Fix login redirect bug");
        const wrote = await sr.setPlaceholderTitle(asSessionId(id), "second message truncated");
        assert.equal(wrote, false);
        assert.equal(await sr.getSessionName(asSessionId(id)), "Fix login redirect bug");
    });

    it("getHistory returns empty entries for fresh session", async () => {
        const sr = makeRegistry();
        const id = uuidv7();
        await seedSession(sr.repo, id);
        sr.invalidateListCache();
        const { entries, leafEntryId } = await sr.getHistory(asSessionId(id));
        assert.equal(entries.length, 0);
        assert.equal(leafEntryId, null);
    });

    // pi 0.85's JsonlSessionRepo tracks open sessions and rejects a second
    // open of the same id with "Session is already open". A one-shot reader
    // that never closes its handle therefore locks the session for the rest of
    // the process: the desktop hit this as a read (snapshot / contextInfo)
    // permanently breaking every subsequent session.attach.
    it("repeated one-shot reads do not leak pi's open-session slot", async () => {
        const sr = makeRegistry();
        const id = uuidv7();
        const created = await sr.repo.create({ id, cwd }, harnessContext);
        await created.close(harnessContext);
        sr.invalidateListCache();

        await sr.getHistory(asSessionId(id));
        await sr.getHistory(asSessionId(id));
        await sr.getSessionFacts(asSessionId(id));
        await sr.renameSession(asSessionId(id), "renamed");

        // The slot must still be free for a real consumer to take.
        const reopened = await sr.repo.open(await sr.openSession(asSessionId(id)), harnessContext);
        await reopened.close(harnessContext);
    });

    // getSessionName and getSessionFacts read the same JSONL, so they share one
    // stream scan and populate both caches. Splitting them back into two reads
    // would double the per-session I/O of session.list, which is the exact cost
    // that drove the daemon into a GC spiral before the scan was introduced.
    //
    // Instead of instrumenting createReadStream (a builtin named import cannot
    // be patched reliably under ESM), the invariant is asserted directly: after
    // one getter warms the cache, the file is removed, so a second read would
    // fail with ENOENT. Both getters still answering proves one scan served both.
    it("getSessionName warms the facts cache — the pair costs one file read", async () => {
        const sr = makeRegistry();
        const id = uuidv7();
        await seedSession(sr.repo, id);
        sr.invalidateListCache();
        await sr.renameSession(asSessionId(id), "titled");
        // Drop both caches so the first getter must stream the file.
        sr.invalidateListCache();

        const meta = await sr.openSession(asSessionId(id));
        assert.equal(await sr.getSessionName(asSessionId(id)), "titled");

        // Any further disk read must now fail. _metadataCache still holds the
        // path, so openSession keeps succeeding — only the stream would break.
        rmSync(meta.path, { force: true });
        assert.deepEqual(await sr.getSessionFacts(asSessionId(id)), {});
        assert.equal(await sr.getSessionActivityAt(asSessionId(id)), undefined);
    });

    it("getSessionFacts warms the name cache — the pair costs one file read", async () => {
        const sr = makeRegistry();
        const id = uuidv7();
        await seedSession(sr.repo, id);
        sr.invalidateListCache();
        await sr.renameSession(asSessionId(id), "titled");
        sr.invalidateListCache();

        const meta = await sr.openSession(asSessionId(id));
        assert.deepEqual(await sr.getSessionFacts(asSessionId(id)), {});

        rmSync(meta.path, { force: true });
        assert.equal(await sr.getSessionName(asSessionId(id)), "titled");
        assert.equal(await sr.getSessionActivityAt(asSessionId(id)), undefined);
    });

    // Facts written at spawn time must survive the round-trip through the
    // stream scan: the on-disk encoding is pi's private value-record format,
    // so a format change would otherwise surface as silently-empty facts.
    it("getSessionFacts reads spawn-time facts back off disk", async () => {
        const sr = makeRegistry();
        const id = uuidv7();
        const created = await sr.repo.create({ id, cwd }, harnessContext);
        await writeSessionFacts(created, { kind: "subagent", agentType: "explorer", depth: 1 });
        await created.close(harnessContext);
        sr.invalidateListCache();

        const facts = await sr.getSessionFacts(asSessionId(id));
        assert.equal(facts.kind, "subagent");
        assert.equal(facts.agentType, "explorer");
        assert.equal(facts.depth, 1);
    });

    it("getSessionActivityAt reads the last message timestamp off disk", async () => {
        const sr = makeRegistry();
        const id = uuidv7();
        const created = await sr.repo.create({ id, cwd }, harnessContext);
        const path = created.metadata.path;
        await created.close(harnessContext);
        await appendFile(
            path,
            `${JSON.stringify({
                kind: "entry",
                id: "e1",
                parentId: null,
                seq: 1,
                timestamp: 1_700_000_000_000,
                type: "message",
                message: { role: "user", content: [{ type: "text", text: "hi" }] },
            })}\n`,
        );
        sr.invalidateListCache();
        assert.equal(await sr.getSessionActivityAt(asSessionId(id)), 1_700_000_000_000);
        const meta = await sr.openSession(asSessionId(id));
        rmSync(meta.path, { force: true });
        assert.equal(await sr.getSessionActivityAt(asSessionId(id)), 1_700_000_000_000);
    });

    it("opening a v3 subagent session writes taco facts before the importer drops metadata", async () => {
        const sr = makeRegistry();
        const parentId = uuidv7();
        const childId = uuidv7();
        await seedSession(sr.repo, parentId);
        const placeholder = await sr.repo.create({ id: childId, cwd }, harnessContext);
        const childPath = placeholder.metadata.path;
        await placeholder.close(harnessContext);
        writeFileSync(
            childPath,
            `${JSON.stringify({
                type: "session",
                version: 3,
                id: childId,
                timestamp: "2026-08-13T16:17:40.770Z",
                cwd,
                metadata: {
                    kind: "subagent",
                    agentType: "explorer",
                    parentSessionId: parentId,
                    parentToolCallId: "call_1",
                    depth: 1,
                },
            })}\n${JSON.stringify({
                type: "message",
                id: "m1",
                parentId: null,
                timestamp: "2026-08-13T16:17:40.795Z",
                message: { role: "user", content: [{ type: "text", text: "explore" }] },
            })}\n`,
        );
        sr.invalidateListCache();

        const recovered = await sr.withSession(asSessionId(childId), (session) =>
            readSessionFacts(session),
        );
        assert.equal(recovered.kind, "subagent");
        assert.equal(recovered.agentType, "explorer");
        assert.equal(recovered.parentSessionId, parentId);
        assert.equal(recovered.parentToolCallId, "call_1");
        assert.equal(recovered.depth, 1);

        sr.invalidateListCache();
        const again = await sr.getSessionFacts(asSessionId(childId));
        assert.equal(again.kind, "subagent");
        assert.equal(again.agentType, "explorer");
    });

    // pi's repo throws "Session is already open" on a second concurrent open of
    // the same id, so parallel reads against a *detached* session have to queue.
    // Reachable in production: several background subagents of one detached
    // parent settle at once and each writes its bookkeeping through withSession.
    // Before the queue, one of them threw and its record was lost — the exact
    // loss that record exists to prevent.
    it("serializes concurrent reads against a detached session", async () => {
        const sr = makeRegistry();
        const sid = uuidv7();
        await seedSession(sr.repo, sid);
        sr.invalidateListCache();

        let concurrent = 0;
        let maxConcurrent = 0;
        const results = await Promise.all(
            Array.from({ length: 6 }, (_, i) =>
                sr.withSession(asSessionId(sid), async (session) => {
                    concurrent++;
                    maxConcurrent = Math.max(maxConcurrent, concurrent);
                    await new Promise((r) => setTimeout(r, 5));
                    const facts = await readSessionFacts(session);
                    concurrent--;
                    return `${i}:${facts.kind ?? "main"}`;
                }),
            ),
        );
        assert.equal(maxConcurrent, 1, "detached reads must not overlap");
        assert.equal(results.length, 6, "every read must still run — queued, not deduped");

        // A rejection must not poison the queue for later callers.
        await assert.rejects(
            sr.withSession(asSessionId(sid), async () => {
                throw new Error("boom");
            }),
            /boom/,
        );
        const after = await sr.withSession(asSessionId(sid), (session) =>
            readSessionFacts(session),
        );
        assert.ok(after, "queue must still serve reads after one rejects");
    });

    it("opening a 0.85 child with header parentSessionId but no facts backfills kind", async () => {
        const sr = makeRegistry();
        const parentId = uuidv7();
        const childId = uuidv7();
        await seedSession(sr.repo, parentId);
        const child = await sr.repo.create(
            { id: childId, cwd, parentSessionId: parentId },
            harnessContext,
        );
        await child.close(harnessContext);
        sr.invalidateListCache();

        const facts = await sr.withSession(asSessionId(childId), (session) =>
            readSessionFacts(session),
        );
        assert.equal(facts.kind, "subagent");
        assert.equal(facts.parentSessionId, parentId);
    });

    it("deleteSession removes from list and emits session.deleted", async () => {
        const sr = makeRegistry();
        const id = uuidv7();
        await seedSession(sr.repo, id);
        sr.invalidateListCache();
        let deleted: string | undefined;
        sr.on("session.deleted", (e: { sessionId: string }) => {
            deleted = e.sessionId;
        });
        await sr.deleteSession(asSessionId(id));
        assert.equal(deleted, id);
        const list = await sr.listSessions();
        assert.equal(list.length, 0);
    });

    // The event is what the server turns into a `session.renamed` push. Without
    // it the summary reaches disk and `session.list`, but no attached client
    // learns about it until it re-pulls the list — which it only does after a
    // send or on startup, so the sidebar sits on a stale title.
    it("setSummaryTitle emits session.renamed with the new name", async () => {
        const sr = makeRegistry();
        const id = uuidv7();
        await seedSession(sr.repo, id);
        sr.invalidateListCache();
        const seen: Array<{ sessionId: string; name: string }> = [];
        sr.on("session.renamed", (e: { sessionId: string; name: string }) => {
            seen.push(e);
        });
        await sr.setSummaryTitle(asSessionId(id), "summarized title");
        assert.deepEqual(seen, [{ sessionId: id, name: "summarized title" }]);
    });

    // A second client window did not issue the rename and has no other way to
    // hear about it, so the push is not filtered by source.
    it("renameSession emits session.renamed", async () => {
        const sr = makeRegistry();
        const id = uuidv7();
        await seedSession(sr.repo, id);
        sr.invalidateListCache();
        const seen: string[] = [];
        sr.on("session.renamed", (e: { name: string }) => {
            seen.push(e.name);
        });
        await sr.renameSession(asSessionId(id), "user chosen");
        assert.deepEqual(seen, ["user chosen"]);
    });

    // Re-summarizing a conversation whose topic has not moved must stay silent:
    // the title is re-derived every completed run, so emitting unconditionally
    // would push a no-change frame once per turn.
    it("re-writing the same title emits nothing", async () => {
        const sr = makeRegistry();
        const id = uuidv7();
        await seedSession(sr.repo, id);
        sr.invalidateListCache();
        await sr.setSummaryTitle(asSessionId(id), "same topic");
        const seen: string[] = [];
        sr.on("session.renamed", (e: { name: string }) => {
            seen.push(e.name);
        });
        await sr.setSummaryTitle(asSessionId(id), "same topic");
        assert.deepEqual(seen, []);
    });

    it("getAttached returns undefined for unattached session", () => {
        const sr = makeRegistry();
        assert.equal(sr.getAttached(asSessionId("never-attached")), undefined);
    });

    it("getSessionKind returns 'main' for unknown session (default)", () => {
        const sr = makeRegistry();
        assert.equal(sr.getSessionKind(asSessionId("never-attached")), "main");
    });

    it("dispose does not throw on empty registry", async () => {
        const sr = makeRegistry();
        await sr.dispose();
    });

    it("toolsForChildSession returns the same taskState the tools were built from", async () => {
        const id = uuidv7();
        await seedSession(repo, id);
        let seenByBuilder: SessionTaskState | undefined;
        const sr = makeRegistry({
            toolsBuilder: (_sid, taskState) => {
                seenByBuilder = taskState;
                return [fakeTool("fake-tool")];
            },
        });
        const { tools, taskState } = await sr.toolsForChildSession(asSessionId(id));
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
