import { strict as assert } from "node:assert";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { before, describe, it } from "node:test";
import type { RpcRequest, RpcResponse, SessionId } from "@taco-ai/protocol";
import { ErrorCodes, makeImCwd } from "@taco-ai/protocol";
import type { ConversationRouter as ConversationRouterType } from "../../src/channels/conversationRouter.ts";
import type { ServerRpcSurface } from "../../src/runtime/serverRpcSurface.ts";
import {
    createJobDispatcher,
    InvalidSessionStrategy,
    ScheduledCommandFailed,
    UnsupportedScheduledCommand,
} from "../../src/scheduler/dispatcher.ts";
import type { Job } from "../../src/scheduler/types.ts";
import type { MethodCtx } from "../../src/server/methodRegistry.ts";
import { getRegisteredMethod } from "../../src/server/methodRegistry.ts";
import { registerBuiltinMethods } from "../../src/server/methods.ts";

export type _ServerRpcSurfaceRef = ServerRpcSurface;

describe("dispatcher", () => {
    type FakeResponse =
        | { id: string; ok: true; result: unknown }
        | {
              id: string;
              ok: false;
              error: { code: string; message: string };
          };

    interface FakeServer {
        calls: RpcRequest[];
        dispatchRpc(req: RpcRequest): Promise<RpcResponse>;
        lookupRoute?(workspace: string): { sessionId: string } | undefined;
    }

    function makeFakeServer(respond: (req: RpcRequest) => Promise<FakeResponse>): FakeServer {
        const calls: RpcRequest[] = [];
        return {
            calls,
            dispatchRpc: async (req) => {
                calls.push(req);
                return respond(req) as Promise<RpcResponse>;
            },
        };
    }

    function invokeJob(workspace: string, prompt: string, overrides: Partial<Job> = {}): Job {
        return {
            id: "test-job",
            name: "test",
            schedule: { kind: "interval", ms: 60_000 },
            command: "agent.invoke",
            args: { workspace, prompt },
            enabled: true,
            run_on_startup: false,
            history: [],
            ...overrides,
        };
    }

    describe("createJobDispatcher — agent.invoke path (new)", () => {
        it("dispatches a single session.create carrying the prompt", async () => {
            const fake = makeFakeServer(async (req) => {
                assert.equal(req.method, "session.create");
                assert.ok(req.id.startsWith("sched-"), `expected sched- prefix, got ${req.id}`);
                const p = req.params as {
                    sessionId?: string;
                    initialPrompt?: string;
                    workspace?: string;
                };
                assert.equal(p.sessionId, req.id);
                assert.equal(p.initialPrompt, "echo hello");
                assert.equal(p.workspace, "/tmp/w");
                return { id: req.id, ok: true, result: { sessionId: req.id } };
            });
            const dispatcher = createJobDispatcher(() => fake);
            await dispatcher(invokeJob("/tmp/w", "echo hello", { sessionStrategy: "new" }));
            assert.equal(fake.calls.length, 1);
        });

        it("uses a fresh sched-<uuid> id each call", async () => {
            const seenIds = new Set<string>();
            const fake = makeFakeServer(async (req) => {
                assert.equal(req.method, "session.create");
                const p = req.params as { sessionId?: string };
                assert.ok(p.sessionId?.startsWith("sched-"), `unexpected id ${p.sessionId}`);
                const sessionId = p.sessionId as string;
                assert.ok(!seenIds.has(sessionId), `duplicate id ${sessionId}`);
                seenIds.add(sessionId);
                return { id: req.id, ok: true, result: { sessionId } };
            });
            const dispatcher = createJobDispatcher(() => fake);
            await dispatcher(invokeJob("/tmp/w", "a", { sessionStrategy: "new" }));
            await dispatcher(invokeJob("/tmp/w", "b", { sessionStrategy: "new" }));
            assert.equal(seenIds.size, 2);
        });

        it("throws ScheduledCommandFailed when dispatchRpc returns !ok", async () => {
            const fake = makeFakeServer(async (req) => ({
                id: req.id,
                ok: false as const,
                error: { code: "not_ready", message: "scheduler not running" },
            }));
            const dispatcher = createJobDispatcher(() => fake);
            await assert.rejects(
                () => dispatcher(invokeJob("/tmp/w", "x")),
                (err: unknown): err is ScheduledCommandFailed =>
                    err instanceof ScheduledCommandFailed &&
                    err.code === "not_ready" &&
                    err.message === "scheduler not running",
            );
        });

        it("throws UnsupportedScheduledCommand for unknown commands", async () => {
            const fake = makeFakeServer(async () => ({
                id: "x",
                ok: true as const,
                result: null,
            }));
            const dispatcher = createJobDispatcher(() => fake);
            await assert.rejects(
                () => dispatcher(invokeJob("/tmp/w", "x", { command: "foo.bar" })),
                (err: unknown): err is UnsupportedScheduledCommand =>
                    err instanceof UnsupportedScheduledCommand &&
                    err.message === "unsupported scheduled command: foo.bar",
            );
        });
    });

    describe("createJobDispatcher — server resolver", () => {
        it("routes im:// workspace to the im server, fs workspace to the fs server", async () => {
            const imServer = makeFakeServer(async (req) => ({
                id: req.id,
                ok: true as const,
                result: { routedTo: "im" },
            }));
            // The fs workspace defaults to `pin`, which probes for an existing
            // session first; report none so the fire is a single create.
            const fsServer = makeFakeServer(async (req) =>
                req.method === "session.history"
                    ? {
                          id: req.id,
                          ok: false as const,
                          error: { code: "not_found", message: "session not found" },
                      }
                    : { id: req.id, ok: true as const, result: { routedTo: "fs" } },
            );
            const dispatcher = createJobDispatcher((workspace) =>
                workspace.startsWith("im://") ? imServer : fsServer,
            );

            const imWorkspace = makeImCwd("ch", "u", "c");
            imServer.lookupRoute = (workspace) =>
                workspace === imWorkspace ? { sessionId: "current-channel-session" } : undefined;
            await dispatcher(invokeJob(imWorkspace, "hi"));
            await dispatcher(invokeJob("/tmp/repo", "hi"));

            assert.equal(imServer.calls.length, 2);
            assert.equal(
                (imServer.calls[0].params as { workspace?: string }).workspace,
                imWorkspace,
            );
            assert.deepEqual(
                fsServer.calls.map((c) => (c.params as { workspace?: string }).workspace),
                ["/tmp/repo", "/tmp/repo"],
            );
            assert.deepEqual(
                fsServer.calls.map((c) => c.method),
                ["session.history", "session.create"],
            );
        });
    });

    describe("createJobDispatcher — reuse strategy", () => {
        it("attaches and prompts the existing session bound to the imCwd", async () => {
            const im = makeImCwd("ch1", "peer-1", "chat-1");
            const existingId = "existing-sess-1";
            const fake = makeFakeServer(async (req) => {
                if (req.method === "session.attach") {
                    const p = req.params as { sessionId?: string; workspace?: string };
                    assert.equal(p.sessionId, existingId);
                    assert.equal(p.workspace, im);
                    return { id: req.id, ok: true as const, result: null };
                }
                if (req.method === "session.prompt") {
                    // PromptParams.text (not prompt) is the wire format.
                    const p = req.params as { sessionId?: string; text?: string };
                    assert.equal(p.sessionId, existingId);
                    assert.equal(p.text, "ping");
                    assert.equal(
                        (req.params as Record<string, unknown>).prompt,
                        undefined,
                        "session.prompt must send 'text', not 'prompt'",
                    );
                    return { id: req.id, ok: true as const, result: null };
                }
                throw new Error(`unexpected method ${req.method}`);
            });
            fake.lookupRoute = (workspace) =>
                workspace === im ? { sessionId: existingId } : undefined;
            const dispatcher = createJobDispatcher(() => fake);
            await dispatcher(invokeJob(im, "ping", { sessionStrategy: "reuse" }));
            assert.equal(fake.calls.length, 2);
            const methods = fake.calls.map((c) => c.method);
            assert.deepEqual(methods, ["session.attach", "session.prompt"]);
        });

        it("throws InvalidSessionStrategy when reuse is set on an fs workspace", async () => {
            const fake = makeFakeServer(async () => {
                throw new Error("should not be called");
            });
            const dispatcher = createJobDispatcher(() => fake);
            await assert.rejects(
                () => dispatcher(invokeJob("/tmp/repo", "x", { sessionStrategy: "reuse" })),
                (err: unknown): err is InvalidSessionStrategy =>
                    err instanceof InvalidSessionStrategy && /im:\/\/ workspace/.test(err.message),
            );
        });

        it("errors when no session exists for the imCwd", async () => {
            const im = makeImCwd("ch1", "peer-1", "chat-1");
            const fake = makeFakeServer(async (req) => {
                throw new Error(`unexpected method ${req.method}`);
            });
            const dispatcher = createJobDispatcher(() => fake);
            await assert.rejects(
                () => dispatcher(invokeJob(im, "x", { sessionStrategy: "reuse" })),
                (err: unknown): err is InvalidSessionStrategy =>
                    err instanceof InvalidSessionStrategy && /no session bound/.test(err.message),
            );
        });

        it("queues the prompt as a follow-up when the session is busy", async () => {
            // The self-collision case: a job force-fired from inside the target
            // conversation's own turn. A bare re-prompt hits LaneBusy →
            // SessionBusy; instead of failing the fire, enqueue it so it runs at
            // the run's next may_finish boundary.
            const im = makeImCwd("ch1", "peer-1", "chat-1");
            const existingId = "existing-sess-1";
            const fake = makeFakeServer(async (req) => {
                if (req.method === "session.attach") {
                    return { id: req.id, ok: true as const, result: null };
                }
                if (req.method === "session.prompt") {
                    return {
                        id: req.id,
                        ok: false as const,
                        error: { code: ErrorCodes.SessionBusy, message: "turn active" },
                    };
                }
                if (req.method === "session.followUp") {
                    const p = req.params as { sessionId?: string; text?: string };
                    assert.equal(p.sessionId, existingId);
                    assert.equal(p.text, "ping");
                    return { id: req.id, ok: true as const, result: { mode: "queued" } };
                }
                throw new Error(`unexpected method ${req.method}`);
            });
            fake.lookupRoute = (workspace) =>
                workspace === im ? { sessionId: existingId } : undefined;
            const dispatcher = createJobDispatcher(() => fake);
            await dispatcher(invokeJob(im, "ping", { sessionStrategy: "reuse" }));
            assert.deepEqual(
                fake.calls.map((c) => c.method),
                ["session.attach", "session.prompt", "session.followUp"],
            );
        });

        it("retries the prompt once when the follow-up reports idle", async () => {
            // The run ended between the busy rejection and the enqueue; the
            // follow-up would otherwise sit in an unconsumed inbox, so re-prompt.
            const im = makeImCwd("ch1", "peer-1", "chat-1");
            const existingId = "existing-sess-1";
            let prompts = 0;
            const fake = makeFakeServer(async (req) => {
                if (req.method === "session.attach") {
                    return { id: req.id, ok: true as const, result: null };
                }
                if (req.method === "session.prompt") {
                    prompts += 1;
                    if (prompts === 1) {
                        return {
                            id: req.id,
                            ok: false as const,
                            error: { code: ErrorCodes.SessionBusy, message: "turn active" },
                        };
                    }
                    return { id: req.id, ok: true as const, result: null };
                }
                if (req.method === "session.followUp") {
                    return { id: req.id, ok: true as const, result: { mode: "idle" } };
                }
                throw new Error(`unexpected method ${req.method}`);
            });
            fake.lookupRoute = (workspace) =>
                workspace === im ? { sessionId: existingId } : undefined;
            const dispatcher = createJobDispatcher(() => fake);
            await dispatcher(invokeJob(im, "ping", { sessionStrategy: "reuse" }));
            assert.deepEqual(
                fake.calls.map((c) => c.method),
                ["session.attach", "session.prompt", "session.followUp", "session.prompt"],
            );
        });

        it("surfaces a follow-up failure instead of the bare busy error", async () => {
            const im = makeImCwd("ch1", "peer-1", "chat-1");
            const fake = makeFakeServer(async (req) => {
                if (req.method === "session.attach") {
                    return { id: req.id, ok: true as const, result: null };
                }
                if (req.method === "session.prompt") {
                    return {
                        id: req.id,
                        ok: false as const,
                        error: { code: ErrorCodes.SessionBusy, message: "turn active" },
                    };
                }
                if (req.method === "session.followUp") {
                    return {
                        id: req.id,
                        ok: false as const,
                        error: { code: "invalid_state", message: "lane wedged" },
                    };
                }
                throw new Error(`unexpected method ${req.method}`);
            });
            fake.lookupRoute = (workspace) =>
                workspace === im ? { sessionId: "existing-sess-1" } : undefined;
            const dispatcher = createJobDispatcher(() => fake);
            await assert.rejects(
                () => dispatcher(invokeJob(im, "ping", { sessionStrategy: "reuse" })),
                (err: unknown): err is ScheduledCommandFailed =>
                    err instanceof ScheduledCommandFailed &&
                    err.code === "invalid_state" &&
                    err.message === "lane wedged",
            );
        });
    });

    describe("createJobDispatcher — pin strategy", () => {
        it("first fire creates sched-pin-<jobId> and invokes onPinnedSessionCreated", async () => {
            const fake = makeFakeServer(async (req) => {
                if (req.method === "session.history") {
                    return {
                        id: req.id,
                        ok: false as const,
                        error: { code: "not_found", message: "session not found" },
                    };
                }
                if (req.method === "session.create") {
                    const p = req.params as { sessionId?: string };
                    assert.equal(p.sessionId, "sched-pin-test-job");
                    return { id: req.id, ok: true as const, result: { sessionId: p.sessionId } };
                }
                throw new Error(`unexpected method ${req.method}`);
            });
            let pinned: { jobId: string; sessionId: string } | undefined;
            const dispatcher = createJobDispatcher(() => fake, {
                onPinnedSessionCreated: async (jobId, sessionId) => {
                    pinned = { jobId, sessionId };
                },
            });
            await dispatcher(invokeJob("/tmp/repo", "kickoff", { sessionStrategy: "pin" }));
            assert.deepEqual(pinned, { jobId: "test-job", sessionId: "sched-pin-test-job" });
        });

        it("subsequent fire attaches the pinned sessionId", async () => {
            const fake = makeFakeServer(async (req) => {
                if (req.method === "session.history") {
                    return { id: req.id, ok: true as const, result: { messages: [] } };
                }
                if (req.method === "session.attach") {
                    const p = req.params as { sessionId?: string };
                    assert.equal(p.sessionId, "sched-pin-test-job");
                    return { id: req.id, ok: true as const, result: null };
                }
                if (req.method === "session.prompt") {
                    // PromptParams.text (not prompt) is the wire format.
                    const p = req.params as { sessionId?: string; text?: string };
                    assert.equal(p.sessionId, "sched-pin-test-job");
                    assert.equal(p.text, "followup");
                    assert.equal(
                        (req.params as Record<string, unknown>).prompt,
                        undefined,
                        "session.prompt must send 'text', not 'prompt'",
                    );
                    return { id: req.id, ok: true as const, result: null };
                }
                throw new Error(`unexpected method ${req.method}`);
            });
            const dispatcher = createJobDispatcher(() => fake, {
                onPinnedSessionCreated: async () => {
                    throw new Error("must not be called after first fire");
                },
            });
            await dispatcher(
                invokeJob("/tmp/repo", "followup", {
                    sessionStrategy: "pin",
                    pinnedSessionId: "sched-pin-test-job",
                }),
            );
            const methods = fake.calls.map((c) => c.method);
            // The existence probe runs first so a dangling id never reaches attach.
            assert.deepEqual(methods, ["session.history", "session.attach", "session.prompt"]);
        });

        it("adopts the session a failed first fire left behind instead of re-creating it", async () => {
            // A first fire that is stopped or errors mid-turn keeps its transcript
            // (session.create no longer deletes a session that has messages) but
            // never reaches onPinnedSessionCreated. The next fire must reuse that
            // session and pin it — session.create on the taken id would fail every
            // tick from then on.
            const fake = makeFakeServer(async (req) => {
                if (req.method === "session.history") {
                    return { id: req.id, ok: true as const, result: { messages: [] } };
                }
                if (req.method === "session.attach" || req.method === "session.prompt") {
                    const p = req.params as { sessionId?: string };
                    assert.equal(p.sessionId, "sched-pin-test-job");
                    return { id: req.id, ok: true as const, result: null };
                }
                throw new Error(`unexpected method ${req.method}`);
            });
            let pinned: { jobId: string; sessionId: string } | undefined;
            const dispatcher = createJobDispatcher(() => fake, {
                onPinnedSessionCreated: async (jobId, sessionId) => {
                    pinned = { jobId, sessionId };
                },
            });
            await dispatcher(invokeJob("/tmp/repo", "retry", { sessionStrategy: "pin" }));
            assert.deepEqual(
                fake.calls.map((c) => c.method),
                ["session.history", "session.attach", "session.prompt"],
            );
            assert.deepEqual(pinned, { jobId: "test-job", sessionId: "sched-pin-test-job" });
        });

        it("re-pins a fresh session when the pinned one is gone (self-heals)", async () => {
            // Previously this errored on every fire, forever: attach against a
            // deleted session throws an opaque `[upstream] Cannot read
            // properties of undefined (reading 'slice')` and nothing ever
            // cleared the dangling id. The job was wedged until someone edited
            // the JSON by hand. Now the probe fails, we fall through to create,
            // and onPinnedSessionCreated re-points the job at the new session.
            const fake = makeFakeServer(async (req) => {
                if (req.method === "session.history") {
                    return {
                        id: req.id,
                        ok: false as const,
                        error: { code: "not_found", message: "session not found" },
                    };
                }
                if (req.method === "session.create") {
                    return {
                        id: req.id,
                        ok: true as const,
                        result: { sessionId: "sched-pin-test-job" },
                    };
                }
                throw new Error(`unexpected method ${req.method}`);
            });
            let repinned: { jobId: string; sessionId: string } | undefined;
            const dispatcher = createJobDispatcher(() => fake, {
                onPinnedSessionCreated: async (jobId, sessionId) => {
                    repinned = { jobId, sessionId };
                },
            });
            await dispatcher(
                invokeJob("/tmp/repo", "x", {
                    sessionStrategy: "pin",
                    pinnedSessionId: "sched-pin-gone",
                }),
            );
            // Never attempted the attach against the dead id; the stored pin and
            // the deterministic id are both probed before falling through.
            assert.deepEqual(
                fake.calls.map((c) => c.method),
                ["session.history", "session.history", "session.create"],
            );
            assert.deepEqual(repinned, { jobId: "test-job", sessionId: "sched-pin-test-job" });
        });

        it("still surfaces a genuine attach failure on a session that does exist", async () => {
            // The probe must not swallow real errors: if the session is present
            // but attach fails (locked, corrupt, model gone), that belongs in
            // history as an err entry rather than silently re-creating.
            const fake = makeFakeServer(async (req) => {
                if (req.method === "session.history") {
                    return { id: req.id, ok: true as const, result: { messages: [] } };
                }
                if (req.method === "session.attach") {
                    return {
                        id: req.id,
                        ok: false as const,
                        error: { code: "invalid_state", message: "no model configured" },
                    };
                }
                throw new Error(`unexpected method ${req.method}`);
            });
            const dispatcher = createJobDispatcher(() => fake, {
                onPinnedSessionCreated: async () => {
                    throw new Error("must not re-pin when the session exists");
                },
            });
            await assert.rejects(
                () =>
                    dispatcher(
                        invokeJob("/tmp/repo", "x", {
                            sessionStrategy: "pin",
                            pinnedSessionId: "sched-pin-test-job",
                        }),
                    ),
                (err: unknown): err is ScheduledCommandFailed =>
                    err instanceof ScheduledCommandFailed && err.code === "invalid_state",
            );
        });
    });

    describe("createJobDispatcher — legacy command handling", () => {
        // Legacy command migration lives in JobStore.readOne, not here. By the
        // time a job reaches the dispatcher, store normalizes it to
        // `command: "agent.invoke"` (or leaves it as a non-empty string the
        // dispatcher can recognize and reject). The dispatcher itself only
        // knows about agent.invoke, so a legacy job that bypasses the store
        // path still fails fast — that's the contract these tests guard.
        it("rejects jobs whose command is empty (no migration path)", async () => {
            const fake = makeFakeServer(async () => {
                throw new Error("must not be called");
            });
            const dispatcher = createJobDispatcher(() => fake);
            const job: Job = {
                id: "empty",
                name: "empty",
                schedule: { kind: "interval", ms: 60_000 },
                command: "",
                args: { workspace: "/tmp/repo", prompt: "x" },
                enabled: true,
                run_on_startup: false,
                history: [],
            };
            await assert.rejects(
                () => dispatcher(job),
                (err: unknown): err is UnsupportedScheduledCommand =>
                    err instanceof UnsupportedScheduledCommand,
            );
        });

        it("rejects a legacy shell-style command that bypassed the store path", async () => {
            const fake = makeFakeServer(async () => {
                throw new Error("must not be called");
            });
            const dispatcher = createJobDispatcher(() => fake);
            const job: Job = {
                id: "open_source_ai_monitor",
                name: "open_source_ai_monitor",
                schedule: { kind: "interval", ms: 300_000 },
                command: "mmx search query",
                args: {
                    q: "github trending open source AI project today 2026",
                    output: "json",
                    quiet: "",
                    workspace: "/tmp/repo",
                    prompt: "x",
                },
                enabled: true,
                run_on_startup: false,
                history: [],
            };
            await assert.rejects(
                () => dispatcher(job),
                (err: unknown): err is UnsupportedScheduledCommand =>
                    err instanceof UnsupportedScheduledCommand &&
                    err.message === "unsupported scheduled command: mmx search query",
            );
        });
    });
});

describe("dispatcher.integration", () => {
    // ───────── helpers ─────────

    interface WorkspaceStub {
        cwd: string;
        attached: Map<SessionId, { prompt(text: string): Promise<{ role: string; text: string }> }>;
        meta: { id: string; createdAt: string; cwd: string; path: string };
        repo: {
            create: (opts: {
                id: SessionId;
                cwd: string;
                metadata?: Record<string, unknown>;
            }) => Promise<unknown>;
            delete: (meta: { id: SessionId }) => Promise<void>;
        };
        defaultModel: { provider: string; id: string };
        sessionCwd: string;
        invalidateListCache(): void;
        attach(id: SessionId): Promise<{
            prompt(text: string): Promise<{ role: string; text: string }>;
        }>;
        detach(id: SessionId): Promise<void>;
        getAttached(id: SessionId): unknown;
        listSessions(): Promise<unknown[]>;
        inFlightAgentToolCallIds(id: SessionId): string[];
        getSessionName(id: string): Promise<string | undefined>;
    }

    function makeWorkspaceStub(): WorkspaceStub {
        const attached = new Map<
            SessionId,
            { prompt(text: string): Promise<{ role: string; text: string }> }
        >();
        const meta = {
            id: "",
            createdAt: "2026-01-01T00:00:00Z",
            cwd: "/tmp/test-ws",
            path: "/tmp/test-ws/.pi/agent/sessions/.jsonl",
        };
        return {
            cwd: "/tmp/test-ws",
            attached,
            meta,
            sessionCwd: "/tmp/test-ws",
            defaultModel: { provider: "openai", id: "gpt-4o-mini" },
            async attach(id) {
                const stub = {
                    async prompt(text: string) {
                        return { role: "assistant", text: `reply to ${text}` };
                    },
                    session: { setName: async () => {} },
                    abort: async () => {},
                    dispose: async () => {},
                };
                attached.set(id, stub);
                return stub;
            },
            async detach(id) {
                attached.delete(id);
            },
            getAttached(id) {
                return attached.get(id);
            },
            async listSessions() {
                return [];
            },
            invalidateListCache() {},
            inFlightAgentToolCallIds() {
                return [];
            },
            async getSessionName() {
                return undefined;
            },
            repo: {
                async create(opts) {
                    meta.id = opts.id;
                    meta.path = `/tmp/test-ws/.pi/agent/sessions/${opts.id}.jsonl`;
                    // Mimic what JsonlSessionRepo writes on disk: header line only.
                    // pi 0.85 fixed the metadata shape, so sidecar-owned facts
                    // (kind / depth) go to the session value store instead;
                    // session.list reads this header on the next list call.
                    const header: Record<string, unknown> = {
                        type: "session_info",
                        id: opts.id,
                        cwd: opts.cwd,
                        createdAt: meta.createdAt,
                    };
                    if (opts.metadata) {
                        header.metadata = opts.metadata;
                    }
                    await mkdir("/tmp/test-ws/.pi/agent/sessions", { recursive: true });
                    await writeFile(meta.path, `${JSON.stringify(header)}\n`);
                    // pi 0.85 exposes metadata as a property, not a getMetadata() call.
                    return {
                        metadata: { ...meta },
                        close: async () => {},
                    };
                },
                async delete(m) {
                    meta.id = m.id;
                },
            },
        };
    }

    interface FakeServer {
        calls: RpcRequest[];
        /** Set to a workspace stub to back the `session.create` handler. */
        workspaceByKey: Map<string, WorkspaceStub>;
        dispatchRpc(req: RpcRequest): Promise<RpcResponse>;
        lookupRoute?(workspace: string): { sessionId: string } | undefined;
        /** Surface to satisfy DispatchSurface. */
        conversationRouterView?: ConversationRouterType;
    }

    /** Build a DispatchSurface that actually invokes the registered
     *  handlers. Each `workspace` string maps to a stub so the handler can
     *  resolve its `workspace` param. Other methods are stubbed to fail
     *  loudly so a bug that goes off-rails surfaces immediately. */
    function makeRealServer(opts: { workspaces: Record<string, WorkspaceStub> }): FakeServer {
        const calls: RpcRequest[] = [];
        const workspaceByKey = new Map<string, WorkspaceStub>(Object.entries(opts.workspaces));
        return {
            calls,
            workspaceByKey,
            async dispatchRpc(req) {
                calls.push(req);
                const handler = getRegisteredMethod(req.method);
                assert.ok(handler, `handler for ${req.method} should be registered`);
                const params = req.params as Record<string, unknown>;
                const workspaceKey = (params.workspace ?? params.cwd) as string | undefined;
                assert.ok(workspaceKey, `${req.method} requires workspace/cwd param`);
                const workspace = workspaceByKey.get(workspaceKey);
                assert.ok(workspace, `no stub for workspace ${workspaceKey}`);
                try {
                    const result = await handler.handler({
                        id: req.id,
                        workspace: workspace as unknown as MethodCtx<unknown>["workspace"],
                        cwd: workspace.cwd,
                        server: {} as MethodCtx<unknown>["server"],
                        params,
                    } as MethodCtx<unknown>);
                    return { id: req.id, ok: true, result } as RpcResponse;
                } catch (e) {
                    const message = e instanceof Error ? e.message : String(e);
                    return {
                        id: req.id,
                        ok: false,
                        error: { code: "internal", message },
                    } as RpcResponse;
                }
            },
        };
    }

    function pinJob(workspace: string, overrides: Partial<Job> = {}): Job {
        return {
            id: "pin-job",
            name: "pin-job",
            schedule: { kind: "interval", ms: 60_000 },
            command: "agent.invoke",
            args: { workspace, prompt: "hello" },
            enabled: true,
            run_on_startup: false,
            history: [],
            ...overrides,
        };
    }

    before(() => {
        registerBuiltinMethods();
    });

    describe("createJobDispatcher → session.create handler integration", () => {
        it("pin strategy first-fire carries workspace+sessionId+initialPrompt through to the handler", async () => {
            // The historical bug: dispatcher tests asserted the dispatcher
            // emitted these params, but the handler was never called — so a
            // signature drift (e.g. params renamed) went undetected. This
            // test fails if any of the three params is dropped, because the
            // handler reads them and would throw on absence.
            const workspace = makeWorkspaceStub();
            const server = makeRealServer({ workspaces: { "/tmp/repo": workspace } });
            const dispatcher = createJobDispatcher(() => server);

            await dispatcher(pinJob("/tmp/repo", { sessionStrategy: "pin" }));

            const createCall = server.calls.find((c) => c.method === "session.create");
            assert.ok(createCall, "session.create should have been invoked");
            const params = createCall.params as {
                workspace?: string;
                sessionId?: string;
                initialPrompt?: string;
            };
            assert.equal(params.workspace, "/tmp/repo", "workspace must round-trip");
            assert.equal(params.sessionId, "sched-pin-pin-job", "sessionId must be stable");
            assert.equal(params.initialPrompt, "hello", "initialPrompt must round-trip");
        });

        it("handler writes the session jsonl header so listSessions can read it back", async () => {
            // The handler calls workspace.repo.create, which writes a header
            // line with id + cwd. listSessions reads the same line on the next
            // session.list call. The IM routing triple is not persisted at all —
            // it is derived from `workspace.imRouting` on every use — so its
            // absence from the header is expected, not a gap.
            const workspace = makeWorkspaceStub();
            const server = makeRealServer({ workspaces: { "/tmp/repo": workspace } });
            const dispatcher = createJobDispatcher(() => server);

            await dispatcher(pinJob("/tmp/repo", { sessionStrategy: "pin" }));

            const raw = await readFile(workspace.meta.path, "utf-8");
            const header = JSON.parse(raw.split("\n", 1)[0]) as { id?: string };
            assert.equal(header.id, "sched-pin-pin-job");
        });

        it("onPinnedSessionCreated fires AFTER session.create completes with the dispatched sessionId", async () => {
            // Order matters: if the callback wrote pinnedSessionId before
            // session.create returned ok, a failed create would leave the
            // job pointing at a session that was never created, and the
            // next fire would hit "no peer for session, reply dropped" or
            // crash on session.attach against a missing jsonl.
            const workspace = makeWorkspaceStub();
            const server = makeRealServer({ workspaces: { "/tmp/repo": workspace } });
            const callOrder: string[] = [];
            // Override dispatchRpc to also record the create order without
            // invoking the real handler (we want to assert call ORDER, not
            // jsonl shape — covered in the previous test). session.history
            // probes the deterministic id even with no pinnedSessionId, so a
            // transcript a failed first fire left behind is adopted, not re-created.
            server.dispatchRpc = async (req) => {
                callOrder.push(`rpc:${req.method}`);
                if (req.method === "session.history") {
                    return {
                        id: req.id,
                        ok: false,
                        error: { code: "not_found", message: "gone" },
                    } as RpcResponse;
                }
                return {
                    id: req.id,
                    ok: true,
                    result: { sessionId: req.id },
                } as RpcResponse;
            };
            const events: Array<{ jobId: string; sessionId: string }> = [];
            const dispatcher = createJobDispatcher(() => server, {
                onPinnedSessionCreated: async (jobId, sessionId) => {
                    callOrder.push("callback");
                    events.push({ jobId, sessionId });
                },
            });

            await dispatcher(pinJob("/tmp/repo", { sessionStrategy: "pin" }));

            // First-time pin fire probes the deterministic id, finds nothing, and
            // creates. Callback lands strictly after the session.create rpc
            // completes.
            assert.deepEqual(callOrder, ["rpc:session.history", "rpc:session.create", "callback"]);
            assert.deepEqual(events, [{ jobId: "pin-job", sessionId: "sched-pin-pin-job" }]);
        });

        it("onPinnedSessionCreated callback order: probe→create→callback when a stale pinnedSessionId is set", async () => {
            // Companion to the previous test. When the job already has a
            // pinnedSessionId but the underlying session is gone, the
            // dispatcher probes first (session.history returns !ok),
            // then re-creates. Pin down the order across both branches so
            // a future refactor can't silently reorder the callback.
            const workspace = makeWorkspaceStub();
            const server = makeRealServer({ workspaces: { "/tmp/repo": workspace } });
            const callOrder: string[] = [];
            server.dispatchRpc = async (req) => {
                callOrder.push(`rpc:${req.method}`);
                if (req.method === "session.history") {
                    return {
                        id: req.id,
                        ok: false,
                        error: { code: "not_found", message: "gone" },
                    } as RpcResponse;
                }
                return {
                    id: req.id,
                    ok: true,
                    result: { sessionId: req.id },
                } as RpcResponse;
            };
            const dispatcher = createJobDispatcher(() => server, {
                onPinnedSessionCreated: async () => {
                    callOrder.push("callback");
                },
            });

            await dispatcher(
                pinJob("/tmp/repo", { sessionStrategy: "pin", pinnedSessionId: "sched-pin-stale" }),
            );

            // The stored pin and the deterministic id are both probed.
            assert.deepEqual(callOrder, [
                "rpc:session.history",
                "rpc:session.history",
                "rpc:session.create",
                "callback",
            ]);
        });
    });

    describe("createJobDispatcher — ServerRpcSurface integration", () => {
        it("uses the registered dispatcher context, not a stub", () => {
            // Sanity check: the integration path requires the handlers to
            // actually be registered. registerBuiltinMethods() in `before`
            // must have populated the registry; we double-check here so a
            // future refactor that drops a registerBuiltinMethods() call
            // fails this test instead of silently passing dispatcher
            // smoke tests.
            assert.ok(
                getRegisteredMethod("session.create"),
                "session.create must be registered before dispatcher integration tests run",
            );
            assert.ok(
                getRegisteredMethod("session.history"),
                "session.history must be registered (pin path probes session existence)",
            );
            assert.ok(
                getRegisteredMethod("session.attach"),
                "session.attach must be registered (pin path re-attaches existing sessions)",
            );
            assert.ok(
                getRegisteredMethod("session.prompt"),
                "session.prompt must be registered (pin path prompts existing sessions)",
            );
        });
    });

    // Avoid the `ServerRpcSurface` import being dead-stripped by biome — the
    // integration test still benefits from the type-level documentation of
    // which surface the dispatcher closes over.
});
