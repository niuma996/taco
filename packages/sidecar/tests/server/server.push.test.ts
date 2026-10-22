/** Consolidated from 7 test files; behaviour unchanged. */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ServerPush, WorkspaceAssociationKey, WorkspaceId } from "@taco-ai/protocol";
import { asSessionId, asWorkspaceId } from "@taco-ai/protocol";
import { ProviderKeyStore } from "../../src/runtime/models/providerKeyStore.ts";
import { ClientSinkRegistry } from "../../src/server/clientSinkRegistry.ts";
import { CompactionPushAdapter } from "../../src/server/compactionPushAdapter.ts";
import { DurablePushLog } from "../../src/server/durablePushLog.ts";
import { NullTransport } from "../../src/server/nullTransport.ts";
import { normalizeMessageUpdate, redactCommandPermissionRequest } from "../../src/server/push.ts";
import type { EmitPushFn } from "../../src/server/pushTypes.ts";
import { SidecarServer } from "../../src/server/server.ts";
import { SessionEventLog } from "../../src/server/sessionEventLog.ts";
import type { Transport } from "../../src/server/transport.ts";
import { useTempTacoHome } from "../_helpers/tempTacoHome.ts";

describe("push.commandPermission", () => {
    describe("redactCommandPermissionRequest", () => {
        it("redacts API keys in the command string", () => {
            const request = {
                requestId: "req-1",
                sessionId: "session-1",
                toolCallId: "call-1",
                command:
                    "curl -H 'Authorization: Bearer sk-ant-api03-abc123def456789012345xyz' https://api.example.com",
                evaluation: {
                    behavior: "ask",
                    risk: "externalSideEffect",
                    reason: "network request",
                },
            };

            const [redacted, wasModified] = redactCommandPermissionRequest(request);
            assert.equal(wasModified, true);
            const redactedObj = redacted as typeof request;
            assert.ok(
                !redactedObj.command.includes("sk-ant-api03-abc123def456789012345xyz"),
                "API key must not appear in redacted command",
            );
            assert.match(redactedObj.command, /\[REDACTED:API_KEY\]/);
        });

        it("redacts bearer tokens outside headers", () => {
            const request = {
                requestId: "req-2",
                sessionId: "session-1",
                toolCallId: "call-2",
                command: "echo Bearer abc123def45678901234567890xyz",
                evaluation: {
                    behavior: "ask",
                    risk: "readOnly",
                    reason: "echo",
                },
            };

            const [redacted, wasModified] = redactCommandPermissionRequest(request);
            assert.equal(wasModified, true);
            const redactedObj = redacted as typeof request;
            assert.ok(
                !redactedObj.command.includes("abc123def45678901234567890xyz"),
                "bearer token must not appear in redacted command",
            );
            assert.match(redactedObj.command, /\[REDACTED:BEARER_TOKEN\]/);
        });

        it("leaves safe commands untouched", () => {
            const request = {
                requestId: "req-3",
                sessionId: "session-1",
                toolCallId: "call-3",
                command: "git status",
                evaluation: {
                    behavior: "ask",
                    risk: "readOnly",
                    reason: "git status",
                },
            };

            const [redacted, wasModified] = redactCommandPermissionRequest(request);
            assert.equal(wasModified, false);
            const redactedObj = redacted as typeof request;
            assert.equal(redactedObj.command, "git status");
        });
    });
});

describe("push.messageUpdate", () => {
    /**
     * normalizeMessageUpdate — the streamed sub-event must reach clients under the
     * name they read.
     *
     * pi 0.85 declares the field as `assistantMessageEvent` but emits it as
     * `event`. Clients read the declared name, so an un-normalized frame drops
     * every streaming delta and the reply appears all at once. Type-checking
     * cannot catch the mismatch (the shipped .d.ts disagrees with the shipped JS),
     * so the guard has to be a runtime assertion on the real event shape.
     *
     * The end-to-end shape is pinned by streaming a faux provider through a real
     * harness in `attachedSession.core.test.ts`; this file covers the pure
     * transform, including the pass-through cases.
     */

    describe("normalizeMessageUpdate", () => {
        it("copies the runtime `event` field onto the declared `assistantMessageEvent`", () => {
            const sub = { type: "text_delta", contentIndex: 0, delta: "hi" };
            const normalized = normalizeMessageUpdate({
                type: "message_update",
                message: { role: "assistant", timestamp: 1 },
                event: sub,
            }) as { assistantMessageEvent?: unknown; event?: unknown };

            assert.deepEqual(
                normalized.assistantMessageEvent,
                sub,
                "clients read assistantMessageEvent; without it every delta is dropped",
            );
            // Both names ship so the frame keeps working whichever one a client
            // reads, and a pi release that honours its own declaration is a no-op.
            assert.deepEqual(normalized.event, sub, "the runtime field is preserved");
        });

        it("leaves an already-conforming event untouched", () => {
            const sub = { type: "text_delta", delta: "hi" };
            const input = {
                type: "message_update",
                message: { role: "assistant" },
                assistantMessageEvent: sub,
            };
            assert.equal(
                normalizeMessageUpdate(input),
                input,
                "same reference — no needless copy when pi honours its declaration",
            );
        });

        it("passes through other event types and non-objects", () => {
            for (const input of [
                { type: "message_end", message: { role: "assistant" } },
                { type: "tool_start", toolCallId: "tc-1" },
                undefined,
                null,
                "not-an-object",
            ]) {
                assert.equal(normalizeMessageUpdate(input), input);
            }
        });

        it("does not invent the field when the runtime omits both names", () => {
            const input = { type: "message_update", message: { role: "assistant" } };
            assert.equal(normalizeMessageUpdate(input), input);
            assert.equal(
                (input as { assistantMessageEvent?: unknown }).assistantMessageEvent,
                undefined,
            );
        });
    });
});

describe("clientSinkRegistry", () => {
    describe("ClientSinkRegistry.hasClient", () => {
        it("ignores non-interactive sinks such as the resident host's NullTransport", () => {
            const registry = new ClientSinkRegistry();
            registry.add(new NullTransport());
            assert.equal(registry.hasClient(), false);
            const desktop: Transport = {
                open: async () => {},
                close: async () => {},
                send: async () => {},
                onRequest: () => {},
            };
            registry.add(desktop);
            assert.equal(registry.hasClient(), true);
            registry.remove(desktop);
            assert.equal(registry.hasClient(), false);
        });
    });
});

describe("associationsFanout", () => {
    /**
     * `workspace.associations_changed` fan-out — which workspaces a change
     * reaches, and in what shape the key travels.
     *
     * Registry keys carry the client's spelling of a directory, association
     * keys the writer's; the same directory spelled differently must still fan
     * out (matching normalizes both sides). The pushed key keeps the caller's
     * raw spelling — the wire contract is raw strings, and the client matches
     * what it sent.
     *
     * Run: cd packages/sidecar && pnpm exec tsx --test tests/server/associationsFanout.test.ts
     */

    useTempTacoHome("associations-fanout");

    interface CapturedPush {
        method: string;
        workspace: string;
        key: WorkspaceAssociationKey;
    }

    /**
     * A bare server with two private seams stubbed for observation: the
     * workspace registry the fan-out iterates (registering real runtimes would
     * pull in the full workspace stack) and the push sink.
     */
    function makeFanoutRecorder(cwds: string[]): { server: SidecarServer; pushes: CapturedPush[] } {
        const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
        const pushes: CapturedPush[] = [];
        const seams = server as unknown as {
            workspaces: { publish: (cwd: WorkspaceId, ws: never) => void };
            emitPush: (
                method: string,
                workspace: string,
                session: unknown,
                params: { key: WorkspaceAssociationKey },
            ) => void;
        };
        for (const cwd of cwds) {
            seams.workspaces.publish(cwd as WorkspaceId, {} as never);
        }
        seams.emitPush = (method, workspace, _session, params) => {
            pushes.push({ method, workspace, key: params.key });
        };
        return { server, pushes };
    }

    describe("workspace.associations_changed fan-out", () => {
        it("reaches a workspace whose registry spelling differs from the writer's, with the raw key", async () => {
            const root = mkdtempSync(join(tmpdir(), "assoc-root-"));
            const { server, pushes } = makeFanoutRecorder(["/tmp/a/../proj", "/tmp/other"]);

            await server.associations.set({ scope: "workspace", id: "/tmp/proj" }, [root]);

            assert.equal(pushes.length, 1);
            assert.equal(pushes[0].method, "workspace.associations_changed");
            assert.equal(pushes[0].workspace, "/tmp/a/../proj");
            assert.deepEqual(pushes[0].key, { scope: "workspace", id: "/tmp/proj" });
        });

        it("fans a channel-scope change to that channel's IM conversations only", async () => {
            const root = mkdtempSync(join(tmpdir(), "assoc-root-"));
            const { server, pushes } = makeFanoutRecorder([
                "im://chan-1/peer-1/chat-1",
                "im://chan-2/peer-1/chat-1",
                "/tmp/local",
            ]);

            await server.associations.set({ scope: "channel", id: "chan-1" }, [root]);

            assert.equal(pushes.length, 1);
            assert.equal(pushes[0].workspace, "im://chan-1/peer-1/chat-1");
        });
    });
});

describe("sessionEventLog", () => {
    describe("SessionEventLog", () => {
        it("replays all frames after the supplied cursor in sequence order", () => {
            const log = new SessionEventLog(3);
            log.append(asWorkspaceId("/workspace"), asSessionId("session"), (seq) => ({
                method: "session.event",
                workspace: asWorkspaceId("/workspace"),
                session: asSessionId("session"),
                seq,
                params: { seq },
            }));
            log.append(asWorkspaceId("/workspace"), asSessionId("session"), (seq) => ({
                method: "session.event",
                workspace: asWorkspaceId("/workspace"),
                session: asSessionId("session"),
                seq,
                params: { seq },
            }));

            const replay = log.replay(asWorkspaceId("/workspace"), asSessionId("session"), 0);

            assert.equal(replay.resetRequired, false);
            assert.deepEqual(
                replay.events.map((event) => event.seq),
                [1, 2],
            );
            assert.equal(replay.lastSeq, 2);
        });

        it("requires a snapshot when the requested cursor predates retained frames", () => {
            const log = new SessionEventLog(2);
            for (let index = 0; index < 3; index++) {
                log.append(asWorkspaceId("/workspace"), asSessionId("session"), (seq) => ({
                    method: "session.event",
                    workspace: asWorkspaceId("/workspace"),
                    session: asSessionId("session"),
                    seq,
                    params: { seq },
                }));
            }

            const replay = log.replay(asWorkspaceId("/workspace"), asSessionId("session"), 0);

            assert.equal(replay.resetRequired, true);
            assert.equal(replay.firstSeq, 2);
            assert.equal(replay.lastSeq, 3);
            assert.deepEqual(replay.events, []);
            assert.equal(log.lastSeq(asWorkspaceId("/workspace"), asSessionId("session")), 3);
        });

        it("releases one session without disturbing other streams", () => {
            const log = new SessionEventLog();
            log.append(asWorkspaceId("/workspace"), asSessionId("drop"), (seq) => ({
                method: "session.event",
                workspace: asWorkspaceId("/workspace"),
                session: asSessionId("drop"),
                seq,
                params: {},
            }));
            log.append(asWorkspaceId("/workspace"), asSessionId("keep"), (seq) => ({
                method: "session.event",
                workspace: asWorkspaceId("/workspace"),
                session: asSessionId("keep"),
                seq,
                params: {},
            }));

            log.clearSession(asWorkspaceId("/workspace"), asSessionId("drop"));

            assert.deepEqual(log.replay(asWorkspaceId("/workspace"), asSessionId("drop"), 0), {
                events: [],
                firstSeq: 1,
                lastSeq: 0,
                resetRequired: false,
            });
            assert.deepEqual(
                log
                    .replay(asWorkspaceId("/workspace"), asSessionId("keep"), 0)
                    .events.map((event) => event.seq),
                [1],
            );
        });

        it("releases every stream for a disposed workspace", () => {
            const log = new SessionEventLog();
            for (const workspace of [asWorkspaceId("/dispose"), asWorkspaceId("/keep")]) {
                log.append(asWorkspaceId(workspace), asSessionId("session"), (seq) => ({
                    method: "session.event",
                    workspace,
                    session: asSessionId("session"),
                    seq,
                    params: {},
                }));
            }

            log.clearWorkspace(asWorkspaceId("/dispose"));

            assert.equal(
                log.replay(asWorkspaceId("/dispose"), asSessionId("session"), 0).lastSeq,
                0,
            );
            assert.equal(log.replay(asWorkspaceId("/keep"), asSessionId("session"), 0).lastSeq, 1);
        });
    });

    describe("SessionEventLog — terminal tombstone (session.deleted)", () => {
        it("appended after N events continues seq (not reset to 1)", () => {
            const log = new SessionEventLog();
            const ws = asWorkspaceId("/workspace");
            const sid = asSessionId("session");
            for (let i = 0; i < 5; i++) {
                log.append(ws, sid, (seq) => ({
                    method: "session.event",
                    workspace: ws,
                    session: sid,
                    seq,
                    params: {},
                }));
            }
            const tombstone = log.append(ws, sid, (seq) => ({
                method: "session.deleted",
                workspace: ws,
                session: sid,
                seq,
                params: {},
            }));
            assert.equal(tombstone.seq, 6);
            assert.notEqual(tombstone.seq, 1);
            const replay = log.replay(ws, sid, 5);
            assert.equal(replay.events.length, 1);
            assert.equal(replay.events[0]?.method, "session.deleted");
            assert.equal(replay.events[0]?.seq, 6);
        });

        it("clearSession before append resets seq to 1 (the anti-pattern)", () => {
            // Regression contrast: clearing first creates a fresh stream whose
            // seq starts at 1 — a client that consumed seq=N discards it as a
            // duplicate. The session.deleted listener must NOT clear first.
            const log = new SessionEventLog();
            const ws = asWorkspaceId("/workspace");
            const sid = asSessionId("session");
            for (let i = 0; i < 5; i++) {
                log.append(ws, sid, (seq) => ({
                    method: "session.event",
                    workspace: ws,
                    session: sid,
                    seq,
                    params: {},
                }));
            }
            log.clearSession(ws, sid);
            const after = log.append(ws, sid, (seq) => ({
                method: "session.deleted",
                workspace: ws,
                session: sid,
                seq,
                params: {},
            }));
            assert.equal(after.seq, 1);
        });
    });

    describe("SessionEventLog — hydrate from disk tail", () => {
        let root: string;
        before(async () => {
            root = await mkdtemp(join(tmpdir(), "taco-event-log-"));
        });
        after(async () => {
            await rm(root, { recursive: true, force: true });
        });

        function emit(
            log: SessionEventLog,
            ws: ReturnType<typeof asWorkspaceId>,
            sid: ReturnType<typeof asSessionId>,
        ) {
            return log.append(ws, sid, (seq) => ({
                method: "session.event" as const,
                workspace: ws,
                session: sid,
                seq,
                params: {},
            }));
        }

        it("continues seq across a simulated process restart", async () => {
            const ws = asWorkspaceId("/ws");
            const sid = asSessionId("restart");
            const disk = new DurablePushLog(root, { flushDelayMs: 1 });
            const first = new SessionEventLog(4, disk);
            for (let i = 0; i < 3; i++) emit(first, ws, sid);
            // Graceful shutdown: drains the buffer and releases the stream claim so
            // the next ring can take it over (see DurablePushLog.claim).
            await first.flushDurable();

            // New process: fresh ring over the same disk tail.
            const restarted = new SessionEventLog(4, disk);
            await restarted.hydrate(ws, sid);
            const next = emit(restarted, ws, sid);

            assert.equal(next.seq, 4);
            assert.equal(restarted.lastSeq(ws, sid), 4);
            const replay = restarted.replay(ws, sid, 2);
            assert.equal(replay.resetRequired, false);
            assert.deepEqual(
                replay.events.map((event) => event.seq),
                [3, 4],
            );
        });

        it("is a no-op while the in-memory ring is live", async () => {
            const ws = asWorkspaceId("/ws");
            const sid = asSessionId("live");
            const disk = new DurablePushLog(root, { flushDelayMs: 1 });
            const log = new SessionEventLog(4, disk);
            emit(log, ws, sid);
            emit(log, ws, sid);
            await log.hydrate(ws, sid);
            const next = emit(log, ws, sid);

            assert.equal(next.seq, 3);
        });

        it("leaves a brand-new session untouched (first frame stays seq 1)", async () => {
            const ws = asWorkspaceId("/ws");
            const sid = asSessionId("fresh");
            const disk = new DurablePushLog(root, { flushDelayMs: 1 });
            const log = new SessionEventLog(4, disk);
            await log.hydrate(ws, sid);
            const first = emit(log, ws, sid);

            assert.equal(first.seq, 1);
        });

        // Two live rings over one tail is the two-connections-one-session case.
        // Each numbers seqs independently, so the tail must follow exactly one of
        // them; the other degrades to snapshot recovery.
        it("does not interleave two live rings sharing one tail", async () => {
            const ws = asWorkspaceId("/ws");
            const sid = asSessionId("contended");
            const disk = new DurablePushLog(root, { flushDelayMs: 1 });
            const owner = new SessionEventLog(8, disk);
            const other = new SessionEventLog(8, disk);

            emit(owner, ws, sid);
            emit(owner, ws, sid);
            emit(other, ws, sid); // seq 1 again, from its own ring
            await owner.flushDurable();

            const restarted = new SessionEventLog(8, disk);
            await restarted.hydrate(ws, sid);
            // 2 from the owner, not 1 from the loser or a 1,2,1 mixture.
            assert.equal(restarted.lastSeq(ws, sid), 2);
            assert.equal(emit(restarted, ws, sid).seq, 3);
        });

        it("without a DurablePushLog hydrate is a no-op", async () => {
            const ws = asWorkspaceId("/ws");
            const sid = asSessionId("nodisk");
            const log = new SessionEventLog();
            await log.hydrate(ws, sid);
            assert.equal(log.lastSeq(ws, sid), 0);
            const first = emit(log, ws, sid);
            assert.equal(first.seq, 1);
        });

        it("clearSession drops the disk tail; clear() keeps it", async () => {
            const ws = asWorkspaceId("/ws");
            const sid = asSessionId("gone");
            const disk = new DurablePushLog(root, { flushDelayMs: 1 });
            const log = new SessionEventLog(4, disk);
            emit(log, ws, sid);
            await log.flushDurable();

            log.clearSession(ws, sid);
            const freshLog = new SessionEventLog(4, disk);
            await freshLog.hydrate(ws, sid);
            assert.equal(freshLog.lastSeq(ws, sid), 0);

            // Process-level clear() is the restart path — disk must survive it.
            const survivor = asSessionId("survivor");
            const keepLog = new SessionEventLog(4, disk);
            emit(keepLog, ws, survivor);
            await keepLog.flushDurable();
            keepLog.clear();
            const restarted = new SessionEventLog(4, disk);
            await restarted.hydrate(ws, survivor);
            assert.equal(restarted.lastSeq(ws, survivor), 1);
        });
    });
});

describe("durablePushLog", () => {
    const WS = asWorkspaceId("/ws");

    // Stand-in for a SessionEventLog: the append claim is identity-based, so tests
    // only need a distinct object per notional ring.
    const ring = (): object => ({});

    function frame(session: string, seq: number, params: Record<string, unknown> = {}): ServerPush {
        return {
            method: "session.event",
            workspace: WS,
            session: asSessionId(session),
            seq,
            params,
        };
    }

    /** Resolve the on-disk filename for a stream without duplicating the hash. */
    async function soleFile(dir: string): Promise<string> {
        const names = await readdir(dir);
        assert.equal(names.length, 1, `expected exactly one tail file, got ${names.join(", ")}`);
        return join(dir, names[0] as string);
    }

    describe("DurablePushLog", () => {
        let root: string;
        before(async () => {
            root = await mkdtemp(join(tmpdir(), "taco-push-log-"));
        });
        after(async () => {
            await rm(root, { recursive: true, force: true });
        });

        it("round-trips buffered frames through flush and loadTail", async () => {
            const disk = new DurablePushLog(root, { flushDelayMs: 1 });
            const owner = ring();
            const sid = asSessionId("roundtrip");
            disk.scheduleAppend(frame(sid, 1), owner);
            disk.scheduleAppend(frame(sid, 2, { delta: "x" }), owner);

            const tail = await disk.loadTail(WS, sid, 512, owner);

            assert.deepEqual(
                tail.map((event) => event.seq),
                [1, 2],
            );
            assert.equal((tail[1]?.params as { delta?: string }).delta, "x");
        });

        it("respects the limit and returns the most recent frames", async () => {
            const disk = new DurablePushLog(root, { flushDelayMs: 1 });
            const owner = ring();
            const sid = asSessionId("limit");
            for (let seq = 1; seq <= 5; seq++) disk.scheduleAppend(frame(sid, seq), owner);

            const tail = await disk.loadTail(WS, sid, 2, owner);

            assert.deepEqual(
                tail.map((event) => event.seq),
                [4, 5],
            );
        });

        it("repairs a torn final line instead of returning or propagating it", async () => {
            const sid = asSessionId("torn");
            const dir = await mkdtemp(join(tmpdir(), "taco-push-log-"));
            try {
                const owner = ring();
                // Seed the file through the log itself so the name matches the
                // (workspace, session) key the reader will derive.
                const seed = new DurablePushLog(dir, { flushDelayMs: 1 });
                seed.scheduleAppend(frame(sid, 1), owner);
                await seed.flush();
                const path = await soleFile(dir);
                const good = await readFile(path, "utf8");
                const torn = `${JSON.stringify(frame(sid, 2)).slice(0, 12)}{"seq":3`;
                await writeFile(path, `${good}${torn}`, "utf8");

                const disk = new DurablePushLog(dir, { flushDelayMs: 1 });
                const reader = ring();
                const tail = await disk.loadTail(WS, sid, 512, reader);

                assert.deepEqual(
                    tail.map((event) => event.seq),
                    [1],
                );
                // The file is repaired: a later append cannot weld onto the torn line.
                disk.scheduleAppend(frame(sid, 2), reader);
                await disk.loadTail(WS, sid, 512, reader);
                const raw = await readFile(path, "utf8");
                const parsedLines = raw
                    .split("\n")
                    .filter((line) => line !== "")
                    .map((line) => JSON.parse(line) as { seq: number });
                assert.deepEqual(
                    parsedLines.map((entry) => entry.seq),
                    [1, 2],
                );
            } finally {
                await rm(dir, { recursive: true, force: true });
            }
        });

        it("compacts a file that exceeds maxFileBytes to the newest keep lines", async () => {
            const sid = asSessionId("compact");
            const dir = await mkdtemp(join(tmpdir(), "taco-push-log-"));
            try {
                const owner = ring();
                const disk = new DurablePushLog(dir, {
                    flushDelayMs: 1,
                    maxFileBytes: 200,
                    keep: 3,
                });
                for (let seq = 1; seq <= 10; seq++) {
                    disk.scheduleAppend(frame(sid, seq, { pad: "0123456789".repeat(2) }), owner);
                    await disk.loadTail(WS, sid, 1, owner); // forces a flush through the chain
                }

                const tail = await disk.loadTail(WS, sid, 512, owner);
                assert.deepEqual(
                    tail.map((event) => event.seq),
                    [8, 9, 10],
                );
                const raw = await readFile(await soleFile(dir), "utf8");
                assert.ok(raw.length < 200 * 10);
            } finally {
                await rm(dir, { recursive: true, force: true });
            }
        });

        it("remove deletes the file and drops buffered frames", async () => {
            const sid = asSessionId("removed");
            const dir = await mkdtemp(join(tmpdir(), "taco-push-log-"));
            try {
                const owner = ring();
                const disk = new DurablePushLog(dir, { flushDelayMs: 60_000 });
                disk.scheduleAppend(frame(sid, 1), owner);
                disk.remove(WS, sid);
                await disk.flush();

                const tail = await disk.loadTail(WS, sid, 512, owner);
                assert.deepEqual(tail, []);
                assert.equal(await readdir(dir).then((names) => names.length), 0);
            } finally {
                await rm(dir, { recursive: true, force: true });
            }
        });

        it("keeps streams isolated in per-stream files", async () => {
            const dir = await mkdtemp(join(tmpdir(), "taco-push-log-"));
            try {
                const owner = ring();
                const disk = new DurablePushLog(dir, { flushDelayMs: 1 });
                disk.scheduleAppend(frame("iso-a", 1), owner);
                disk.scheduleAppend(frame("iso-b", 1), owner);

                const a = await disk.loadTail(WS, asSessionId("iso-a"), 512, owner);
                const b = await disk.loadTail(WS, asSessionId("iso-b"), 512, owner);
                assert.equal(a.length, 1);
                assert.equal(b.length, 1);
                assert.equal(await readdir(dir).then((names) => names.length), 2);
            } finally {
                await rm(dir, { recursive: true, force: true });
            }
        });

        // The ring key is (workspace, session); a client may supply its own session
        // id to session.create, so two workspaces can legitimately share one.
        it("separates the same session id across two workspaces", async () => {
            const dir = await mkdtemp(join(tmpdir(), "taco-push-log-"));
            try {
                const owner = ring();
                const other = asWorkspaceId("/other-ws");
                const sid = asSessionId("shared-id");
                const disk = new DurablePushLog(dir, { flushDelayMs: 1 });

                disk.scheduleAppend({ ...frame(sid, 1), workspace: WS }, owner);
                disk.scheduleAppend(
                    { ...frame(sid, 7), workspace: other, params: { x: 1 } },
                    owner,
                );

                const a = await disk.loadTail(WS, sid, 512, owner);
                const b = await disk.loadTail(other, sid, 512, owner);
                assert.deepEqual(
                    a.map((e) => e.seq),
                    [1],
                );
                assert.deepEqual(
                    b.map((e) => e.seq),
                    [7],
                );
                assert.equal(await readdir(dir).then((names) => names.length), 2);
            } finally {
                await rm(dir, { recursive: true, force: true });
            }
        });

        describe("append claim", () => {
            it("admits only the first ring to touch a stream", async () => {
                const dir = await mkdtemp(join(tmpdir(), "taco-push-log-"));
                try {
                    const first = ring();
                    const second = ring();
                    const sid = asSessionId("contended");
                    const disk = new DurablePushLog(dir, { flushDelayMs: 1 });

                    disk.scheduleAppend(frame(sid, 1), first);
                    // Second ring restarts numbering at 1; interleaving the two would
                    // make the tail hydrate a sequence that never existed.
                    disk.scheduleAppend(frame(sid, 1, { from: "second" }), second);
                    disk.scheduleAppend(frame(sid, 2), first);

                    const tail = await disk.loadTail(WS, sid, 512, first);
                    assert.deepEqual(
                        tail.map((event) => event.seq),
                        [1, 2],
                    );
                    assert.ok(
                        tail.every(
                            (event) => (event.params as { from?: string }).from === undefined,
                        ),
                        "the losing ring's frame must not be persisted",
                    );
                } finally {
                    await rm(dir, { recursive: true, force: true });
                }
            });

            it("returns an empty tail to a ring that does not hold the claim", async () => {
                const dir = await mkdtemp(join(tmpdir(), "taco-push-log-"));
                try {
                    const first = ring();
                    const sid = asSessionId("claimed");
                    const disk = new DurablePushLog(dir, { flushDelayMs: 1 });
                    disk.scheduleAppend(frame(sid, 1), first);
                    await disk.flush();

                    // A non-owner must not adopt seqs it will then be unable to extend.
                    assert.deepEqual(await disk.loadTail(WS, sid, 512, ring()), []);
                    assert.equal((await disk.loadTail(WS, sid, 512, first)).length, 1);
                } finally {
                    await rm(dir, { recursive: true, force: true });
                }
            });

            it("hands the claim over after releaseOwner", async () => {
                const dir = await mkdtemp(join(tmpdir(), "taco-push-log-"));
                try {
                    const first = ring();
                    const second = ring();
                    const sid = asSessionId("handover");
                    const disk = new DurablePushLog(dir, { flushDelayMs: 1 });

                    disk.scheduleAppend(frame(sid, 1), first);
                    await disk.flush();
                    disk.releaseOwner(first);

                    // A reconnecting client must be able to continue the stream.
                    const tail = await disk.loadTail(WS, sid, 512, second);
                    assert.deepEqual(
                        tail.map((event) => event.seq),
                        [1],
                    );
                    disk.scheduleAppend(frame(sid, 2), second);
                    const extended = await disk.loadTail(WS, sid, 512, second);
                    assert.deepEqual(
                        extended.map((event) => event.seq),
                        [1, 2],
                    );
                } finally {
                    await rm(dir, { recursive: true, force: true });
                }
            });
        });

        describe("flush", () => {
            it("drains frames whose timer has not fired yet", async () => {
                const dir = await mkdtemp(join(tmpdir(), "taco-push-log-"));
                try {
                    const owner = ring();
                    // A window far longer than the test: only an explicit flush can
                    // land these, which is the graceful-shutdown case.
                    const disk = new DurablePushLog(dir, { flushDelayMs: 60_000 });
                    const sid = asSessionId("shutdown");
                    disk.scheduleAppend(frame(sid, 1), owner);
                    disk.scheduleAppend(frame(sid, 2), owner);

                    await disk.flush();

                    const raw = await readFile(await soleFile(dir), "utf8");
                    const seqs = raw
                        .split("\n")
                        .filter((line) => line !== "")
                        .map((line) => (JSON.parse(line) as { seq: number }).seq);
                    assert.deepEqual(seqs, [1, 2]);
                } finally {
                    await rm(dir, { recursive: true, force: true });
                }
            });
        });
    });
});

describe("compactionPushAdapter", () => {
    /**
     * CompactionPushAdapter unit tests — key behaviour during compaction.
     *
     * Contract:
     *   - inflight key absent → immediately returns true (handler doesn't wait)
     *   - inflight key present, committed → emits `compaction:done:${key}` → resolves true
     *   - inflight key present, timeout → resolves false (handler doesn't block)
     *
     * The frames below use the production event names (`taco_compaction_start` /
     * `taco_compaction_end`), which is what the controller's lifecycle sink emits.
     * pi 0.85 emits no `session_before_compact` / `session_compact` onto that bus.
     */

    /** No-op emitPush — the interlock tests only care about inflight/await state. */
    const noopEmit: EmitPushFn = () => {};

    function newAdapter(): CompactionPushAdapter {
        return new CompactionPushAdapter(noopEmit);
    }

    /** An adapter plus every push frame it emitted, in order. */
    function newRecordingAdapter(): {
        adapter: CompactionPushAdapter;
        frames: Array<{ method: string; params?: unknown }>;
    } {
        const frames: Array<{ method: string; params?: unknown }> = [];
        const adapter = new CompactionPushAdapter((method, _cwd, _sid, params) => {
            frames.push({ method: String(method), params });
        });
        return { adapter, frames };
    }

    /** Start a compaction the way the controller's lifecycle sink does. */
    function start(
        adapter: CompactionPushAdapter,
        cwd: unknown,
        sessionId: unknown,
        tokensBefore = 100,
    ): void {
        adapter.handleSessionEvent(cwd as never, sessionId as never, {
            type: "taco_compaction_start",
            tokensBefore,
        });
    }

    /** End a compaction the way the controller's lifecycle sink does. */
    function end(
        adapter: CompactionPushAdapter,
        cwd: unknown,
        sessionId: unknown,
        payload: { committed?: { summaryChars: number; fromHook: boolean }; reason?: string },
    ): void {
        adapter.handleSessionEvent(cwd as never, sessionId as never, {
            type: "taco_compaction_end",
            ...payload,
        });
    }

    describe("CompactionPushAdapter.awaitCompactionEnd", () => {
        it("returns true immediately when the session is not compressing", async () => {
            const adapter = newAdapter();
            const cwd = asWorkspaceId("/tmp/ws");
            const sessionId = asSessionId("sess-not-compacting");

            const start = Date.now();
            const ok = await adapter.awaitCompactionEnd(cwd, sessionId, 5000);
            const elapsed = Date.now() - start;

            assert.equal(ok, true);
            assert.ok(elapsed < 50, `should return fast, took ${elapsed}ms`);
        });

        it("resolves true when compaction:done fires before timeout", async () => {
            const adapter = newAdapter();
            const cwd = asWorkspaceId("/tmp/ws");
            const sessionId = asSessionId("sess-compacting-fast");

            start(adapter, cwd, sessionId);
            setTimeout(() => {
                end(adapter, cwd, sessionId, {
                    committed: { summaryChars: 9, fromHook: true },
                });
            }, 50);

            const ok = await adapter.awaitCompactionEnd(cwd, sessionId, 1000);
            assert.equal(ok, true);
            assert.equal(adapter.isCompressing(cwd, sessionId), false);
        });

        it("returns false when timeout elapses before done fires", async () => {
            const adapter = newAdapter();
            const cwd = asWorkspaceId("/tmp/ws");
            const sessionId = asSessionId("sess-compacting-slow");

            // Simulate started, but never finished — let await hit the timeout path.
            start(adapter, cwd, sessionId);

            const before = Date.now();
            const ok = await adapter.awaitCompactionEnd(cwd, sessionId, 100);
            const elapsed = Date.now() - before;

            assert.equal(ok, false);
            assert.ok(elapsed >= 95, `should wait ~100ms, took ${elapsed}ms`);
            // isCompressing still true (compression didn't finish; timeout path doesn't clean up)
            assert.equal(adapter.isCompressing(cwd, sessionId), true);
        });

        it("isCompressing reflects inflight membership", () => {
            const adapter = newAdapter();
            const cwd = asWorkspaceId("/tmp/ws");
            const sessionId = asSessionId("sess-toggle");

            assert.equal(adapter.isCompressing(cwd, sessionId), false);
            start(adapter, cwd, sessionId, 1);
            assert.equal(adapter.isCompressing(cwd, sessionId), true);
            end(adapter, cwd, sessionId, { committed: { summaryChars: 1, fromHook: false } });
            assert.equal(adapter.isCompressing(cwd, sessionId), false);
        });
    });

    describe("CompactionPushAdapter finished-frame outcome", () => {
        /** Pull the CompactionFinished params out of a recorded frame list. */
        function finishedParams(frames: Array<{ method: string; params?: unknown }>): {
            failed?: boolean;
            reason?: string;
            failureMessage?: string;
            summaryChars?: number;
            fromHook?: boolean;
        } {
            const frame = frames.find((f) => f.method === "session.compaction_finished");
            assert.ok(frame, "a CompactionFinished frame must be emitted");
            return frame.params as never;
        }

        it("reports success when the end signal carries a committed summary", () => {
            // Regression: success was previously derived from a `session_compact`
            // event that pi 0.85 never emits, so every successful compaction was
            // pushed to the desktop as a failure.
            const { adapter, frames } = newRecordingAdapter();
            const cwd = asWorkspaceId("/tmp/ws");
            const sessionId = asSessionId("sess-commit");

            start(adapter, cwd, sessionId, 4200);
            end(adapter, cwd, sessionId, {
                committed: { summaryChars: 1234, fromHook: true },
            });

            const finished = finishedParams(frames);
            assert.equal(
                finished.failed,
                false,
                "a committed summary must not be reported as failed",
            );
            assert.equal(finished.summaryChars, 1234);
            assert.equal(finished.fromHook, true);
            assert.equal(
                finished.failureMessage,
                undefined,
                "a successful compaction must not carry failure copy",
            );
        });

        it("reports failure carrying the classification when the end signal has none", () => {
            const { adapter, frames } = newRecordingAdapter();
            const cwd = asWorkspaceId("/tmp/ws");
            const sessionId = asSessionId("sess-nothing");

            start(adapter, cwd, sessionId);
            end(adapter, cwd, sessionId, { reason: "nothing" });

            const finished = finishedParams(frames);
            assert.equal(finished.failed, true);
            assert.equal(finished.reason, "nothing");
            assert.equal(finished.summaryChars, 0);
        });

        it("keeps the generic failure copy when nothing is classified", () => {
            const { adapter, frames } = newRecordingAdapter();
            const cwd = asWorkspaceId("/tmp/ws");
            const sessionId = asSessionId("sess-unclassified");

            start(adapter, cwd, sessionId);
            end(adapter, cwd, sessionId, {});

            const finished = finishedParams(frames);
            assert.equal(finished.failed, true);
            assert.equal(finished.reason, undefined);
            assert.equal(finished.failureMessage, "compaction did not commit a summary");
        });
    });
});
