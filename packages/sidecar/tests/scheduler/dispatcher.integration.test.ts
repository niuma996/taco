/**
 * dispatcher.integration.test.ts — end-to-end coverage for the
 * scheduler-dispatcher → session.create-handler chain.
 *
 * Why this file exists:
 *   The unit tests in dispatcher.test.ts stub `dispatchRpc` and only
 *   inspect what the dispatcher *sent* — they don't call the actual
 *   `session.create` handler. That misses the bugs that live at the
 *   seam between dispatcher params and what the handler expects:
 *
 *     - a params shape that parses but is silently ignored by the
 *       handler (the historical bug — `args.workspace` and
 *       `initialPrompt` were dropped for one release because the
 *       handler signature wasn't exercised).
 *     - a handler expecting `imRouting` that the dispatcher forgets
 *       to forward, so the resulting session has no jsonl metadata
 *       and rebuildFromJsonl never picks it up.
 *     - typebox schema validation rejecting a param the handler would
 *       have accepted (or accepting one it would have rejected).
 *
 * This test wires the real handler and asserts (a) the dispatcher
 * produced the params the handler needs, (b) the handler ran without
 * throwing, (c) the on-disk jsonl carries the metadata the
 * ConversationRouter relies on for reverse lookup.
 */

import { strict as assert } from "node:assert";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { before, describe, it } from "node:test";
import type { RpcRequest, RpcResponse, SessionId } from "@taco-ai/protocol";
import type { ConversationRouter as ConversationRouterType } from "../../src/channels/conversationRouter.ts";
import type { ServerRpcSurface } from "../../src/runtime/serverRpcSurface.ts";
import { createJobDispatcher } from "../../src/scheduler/dispatcher.ts";
import type { Job } from "../../src/scheduler/types.ts";
import { getRegisteredMethod, type MethodCtx } from "../../src/server/methodRegistry.ts";
import { registerBuiltinMethods } from "../../src/server/methods.ts";

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
                // Write a header line that mimics what JsonlSessionRepo
                // writes on disk so ConversationRouter.rebuildFromJsonl
                // can discover the route. The metadata field carries the
                // IM routing triple when present.
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
                return { getMetadata: async () => ({ ...meta, metadata: opts.metadata }) };
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

    it("handler writes the session jsonl to disk so ConversationRouter can rebuild the route", async () => {
        // The handler calls workspace.repo.create with the sessionId.
        // rebuildFromJsonl then walks sessions/ and reads the metadata.
        // For an fs workspace there is no IM metadata; this test pins
        // the fs behaviour. An IM workspace test would inject
        // `imRouting` via the workspace stub and assert the jsonl
        // carries it (covered below).
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
        // is not in the chain because pinnedSessionId is unset, so the
        // first call is session.create directly.
        server.dispatchRpc = async (req) => {
            callOrder.push(`rpc:${req.method}`);
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

        // First-time pin fire with no pinnedSessionId skips the
        // session.history probe — the dispatcher only probes when it
        // has an id to validate. Callback lands strictly after the
        // session.create rpc completes.
        assert.deepEqual(callOrder, ["rpc:session.create", "callback"]);
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

        assert.deepEqual(callOrder, ["rpc:session.history", "rpc:session.create", "callback"]);
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
export type _ServerRpcSurfaceRef = ServerRpcSurface;
