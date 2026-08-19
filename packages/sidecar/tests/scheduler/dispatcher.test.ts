/**
 * dispatcher.test.ts — verifies the JobCommandInvoker routes `agent.invoke`
 * through `SidecarServer.dispatchRpc` and surfaces errors as
 * ScheduledCommandFailed so the runner records a meaningful reason.
 *
 * Strategy coverage:
 *  - `new`     (default): single session.create carrying initialPrompt.
 *  - `reuse`   (IM only): session.attach + session.prompt against an
 *              existing session for the imCwd.
 *  - `pin`     : first fire creates `sched-pin-<jobId>` and invokes
 *              onPinnedSessionCreated; subsequent fires attach that id.
 *              A pin against a deleted session errors (history=err).
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { makeImCwd, type RpcRequest, type RpcResponse } from "@taco-ai/protocol";
import {
    createJobDispatcher,
    InvalidSessionStrategy,
    ScheduledCommandFailed,
    UnsupportedScheduledCommand,
} from "../../src/scheduler/dispatcher.ts";
import type { Job } from "../../src/scheduler/types.ts";

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
    /** Records each route registration so tests can assert the dispatcher
     *  binds the pinned session to the IM triple after creation. */
    registeredRoutes: Array<{ workspace: string; sessionId: string }>;
    registerRoute(workspace: string, sessionId: string): Promise<void>;
}

function makeFakeServer(respond: (req: RpcRequest) => Promise<FakeResponse>): FakeServer {
    const calls: RpcRequest[] = [];
    const registeredRoutes: Array<{ workspace: string; sessionId: string }> = [];
    return {
        calls,
        registeredRoutes,
        dispatchRpc: async (req) => {
            calls.push(req);
            return respond(req) as Promise<RpcResponse>;
        },
        registerRoute: async (workspace, sessionId) => {
            registeredRoutes.push({ workspace, sessionId });
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
        await dispatcher(invokeJob("/tmp/w", "echo hello"));
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
        await dispatcher(invokeJob("/tmp/w", "a"));
        await dispatcher(invokeJob("/tmp/w", "b"));
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
        const fsServer = makeFakeServer(async (req) => ({
            id: req.id,
            ok: true as const,
            result: { routedTo: "fs" },
        }));
        const dispatcher = createJobDispatcher((workspace) =>
            workspace.startsWith("im://") ? imServer : fsServer,
        );

        const imWorkspace = makeImCwd("ch", "u", "c");
        await dispatcher(invokeJob(imWorkspace, "hi"));
        await dispatcher(invokeJob("/tmp/repo", "hi"));

        assert.equal(imServer.calls.length, 1);
        assert.equal((imServer.calls[0].params as { workspace?: string }).workspace, imWorkspace);
        assert.equal(fsServer.calls.length, 1);
        assert.equal((fsServer.calls[0].params as { workspace?: string }).workspace, "/tmp/repo");
    });
});

describe("createJobDispatcher — reuse strategy", () => {
    it("attaches and prompts the existing session bound to the imCwd", async () => {
        const im = makeImCwd("ch1", "peer-1", "chat-1");
        const existingId = "existing-sess-1";
        const fake = makeFakeServer(async (req) => {
            if (req.method === "session.list") {
                return {
                    id: req.id,
                    ok: true as const,
                    result: { sessions: [{ sessionId: existingId }] },
                };
            }
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
        const dispatcher = createJobDispatcher(() => fake);
        await dispatcher(invokeJob(im, "ping", { sessionStrategy: "reuse" }));
        assert.equal(fake.calls.length, 3);
        const methods = fake.calls.map((c) => c.method);
        assert.deepEqual(methods, ["session.list", "session.attach", "session.prompt"]);
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
            if (req.method === "session.list") {
                return { id: req.id, ok: true as const, result: { sessions: [] } };
            }
            throw new Error(`unexpected method ${req.method}`);
        });
        const dispatcher = createJobDispatcher(() => fake);
        await assert.rejects(
            () => dispatcher(invokeJob(im, "x", { sessionStrategy: "reuse" })),
            (err: unknown): err is InvalidSessionStrategy =>
                err instanceof InvalidSessionStrategy && /no session bound/.test(err.message),
        );
    });
});

describe("createJobDispatcher — pin strategy", () => {
    it("first fire creates sched-pin-<jobId> and invokes onPinnedSessionCreated", async () => {
        const fake = makeFakeServer(async (req) => {
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
        // Never attempted the attach against the dead id.
        assert.deepEqual(
            fake.calls.map((c) => c.method),
            ["session.history", "session.create"],
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

    it("re-registers the route on the attach path (index is lost on restart)", async () => {
        // The reverse index is in-memory only. After a daemon restart the
        // pinned session already exists, so every fire takes the attach
        // branch — if that branch doesn't re-register, replies are dropped
        // for the rest of the daemon's life.
        const im = makeImCwd("wechat", "peer-1", "chat-1");
        const fake = makeFakeServer(async (req) => ({
            id: req.id,
            ok: true as const,
            result: {},
        }));
        const dispatcher = createJobDispatcher(() => fake);
        await dispatcher(
            invokeJob(im, "tick", {
                sessionStrategy: "pin",
                pinnedSessionId: "sched-pin-test-job",
            }),
        );
        assert.deepEqual(fake.registeredRoutes, [
            {
                workspace: im,
                sessionId: "sched-pin-test-job",
            },
        ]);
        // Registration must land before the prompt, else the first reply of
        // the turn races the binding. The probe precedes both.
        const methods = fake.calls.map((c) => c.method);
        assert.deepEqual(methods, ["session.history", "session.attach", "session.prompt"]);
    });

    it("registers the pinned IM session so channel replies can address the peer", async () => {
        // Without registerRoute the dispatcher would create a
        // `sched-pin-*` session but never tell conversationRouter about it,
        // so the channel's resolvePeer(sessionId) misses and the agent's
        // reply is logged as "no peer for session, reply dropped".
        const im = makeImCwd("wechat", "peer-1", "chat-1");
        const fake = makeFakeServer(async (req) => {
            if (req.method === "session.create") {
                return {
                    id: req.id,
                    ok: true as const,
                    result: { sessionId: "sched-pin-test-job" },
                };
            }
            throw new Error(`unexpected method ${req.method}`);
        });
        const dispatcher = createJobDispatcher(() => fake);
        await dispatcher(invokeJob(im, "kickoff", { sessionStrategy: "pin" }));
        assert.equal(fake.registeredRoutes.length, 1);
        assert.deepEqual(fake.registeredRoutes[0], {
            workspace: im,
            sessionId: "sched-pin-test-job",
        });
    });

    it("registerRoute failure does not fail the fire (logged as warning)", async () => {
        // The pin session was created; the agent may already be running.
        // If registerRoute throws, the better tradeoff is to let the fire
        // complete (history=ok) and surface the routing miss in the next
        // outbound reply than to nuke a multi-second agent turn.
        const im = makeImCwd("wechat", "peer-1", "chat-1");
        let registerCalled = false;
        const fake: FakeServer = {
            calls: [],
            registeredRoutes: [],
            dispatchRpc: async (req) => ({
                id: req.id,
                ok: true as const,
                result: { sessionId: "sched-pin-test-job" },
            }),
            registerRoute: async () => {
                registerCalled = true;
                throw new Error("routing store locked");
            },
        };
        const dispatcher = createJobDispatcher(() => fake);
        await dispatcher(invokeJob(im, "kickoff", { sessionStrategy: "pin" }));
        assert.equal(registerCalled, true);
    });

    it("skips registerRoute when server does not provide it (back-compat)", async () => {
        // Tests / future call sites that only implement dispatchRpc should
        // still work — registerRoute is optional on the surface.
        const fake = makeFakeServer(async () => ({
            id: "x",
            ok: true as const,
            result: { sessionId: "sched-pin-test-job" },
        }));
        // Strip registerRoute off the surface.
        const surface: { dispatchRpc: FakeServer["dispatchRpc"] } = {
            dispatchRpc: fake.dispatchRpc,
        };
        const dispatcher = createJobDispatcher(() => surface);
        await dispatcher(
            invokeJob(makeImCwd("wechat", "p", "c"), "kickoff", { sessionStrategy: "pin" }),
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
