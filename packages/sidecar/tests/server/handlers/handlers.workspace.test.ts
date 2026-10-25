/** Consolidated from 2 test files; behaviour unchanged. */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, before, beforeEach, describe, it } from "node:test";
import type { RpcResponse } from "@taco-ai/protocol";
import { MEMORY_CONTENT_MAX_CHARS } from "@taco-ai/protocol";
import { hashOf, LocalMemoryStore, NoOpMemoryStore } from "../../../src/memory/index.ts";
import type { MemoryEntry } from "../../../src/memory/types.ts";
import type { WorkspaceRuntime } from "../../../src/runtime/workspace.ts";
import type { MethodCtx } from "../../../src/server/methodRegistry.ts";
import { getRegisteredMethod, RpcHandlerError } from "../../../src/server/methodRegistry.ts";
import { registerBuiltinMethods } from "../../../src/server/methods.ts";
import { callMethod } from "../../_helpers/handlerCall.ts";

describe("jobs", () => {
    /**
     * jobs.* handler — unsafe-ID validation tests.
     *
     * The handler signature is `MethodCtx<JobsXxxParams>` and `params` in
     * that ctx IS the wire body. For `jobs.create`, the desktop client sends
     * `call(client, JOBS_RPC.create, { job })` (see
     * `clients/taco-desktop/src/lib/jobsClient.ts`), so on the server
     * `params = { job: { ... } }`. `jobs.update` is the same shape. The
     * `jobs.delete` / `jobs.runNow` / `jobs.history` / `jobs.get` calls
     * use a flat `{ id }` payload — their `params` is `{ id }` directly.
     *
     * `params: { workspace, params: { job: ... } }` is NOT the wire shape:
     * `assertJob(params, "job")` would read the inner wrapper, throw on the
     * missing `obj.id`, and never reach `assertSafeJobId` — a test that
     * passes for the wrong reason.
     *
     * These tests use the real wire shape callers actually depend on.
     */

    type AnyServer = MethodCtx<unknown>["server"];

    /** Stub controller that records every call. The unsafe-ID tests
     *  assert `controllerCalls` is empty — unsafe IDs must reject before any
     *  controller method runs. The wire `server` object nests `jobs` so
     *  `server.jobs.list` resolves as the handler expects. */
    function makeStubServer(controllerCalls: string[]) {
        const store = new Map<string, unknown>();
        const jobs = {
            list: async (actor?: unknown) => {
                controllerCalls.push(`list:${formatActor(actor)}`);
                return [];
            },
            get: async (id: string, actor?: unknown) => {
                controllerCalls.push(`get:${id}:${formatActor(actor)}`);
                return store.get(id) ?? null;
            },
            create: async (job: unknown, actor?: unknown) => {
                const j = job as { id?: string };
                controllerCalls.push(`create:${j.id ?? "?"}:${formatActor(actor)}`);
                store.set(j.id as string, j);
                return job;
            },
            update: async (job: unknown, actor?: unknown) => {
                const j = job as { id?: string };
                controllerCalls.push(`update:${j.id ?? "?"}:${formatActor(actor)}`);
                store.set(j.id as string, j);
                return job;
            },
            delete: async (id: string, actor?: unknown) => {
                controllerCalls.push(`delete:${id}:${formatActor(actor)}`);
            },
            runNow: async (id: string, actor?: unknown) => {
                controllerCalls.push(`runNow:${id}:${formatActor(actor)}`);
                return true;
            },
            history: async (id: string, actor?: unknown) => {
                controllerCalls.push(`history:${id}:${formatActor(actor)}`);
                return null;
            },
        };
        return { jobs } as unknown as AnyServer;
    }

    function formatActor(actor: unknown): string {
        if (!actor || typeof actor !== "object") return "none";
        const a = actor as { kind?: string };
        if (a.kind === "im") return "im";
        if (a.kind === "ide") return "ide";
        return "?";
    }

    describe("jobs RPC handlers — built-in jobs (wire-shape)", () => {
        const builtinJob = (args: Record<string, unknown>, command = "memory.dream") => ({
            id: "memory-dream",
            name: "Memory consolidation",
            schedule: { kind: "cron", expr: "17 4 * * *" },
            command,
            args,
            enabled: true,
            run_on_startup: true,
            builtin: true,
            history: [],
        });

        it("jobs.update passes a built-in through with cleaned args, no workspace/prompt needed", async () => {
            registerBuiltinMethods();
            const controllerCalls: string[] = [];
            const server = makeStubServer(controllerCalls);
            const result = (await callMethod("jobs.update", {
                server,
                params: { job: builtinJob({ minHours: 48, prompt: "smuggled" }) },
            })) as { job: { args: Record<string, unknown> } };
            assert.deepEqual(controllerCalls, ["update:memory-dream:none"]);
            assert.deepEqual(result.job.args, { minHours: 48 });
        });

        it("jobs.update rejects out-of-range built-in args before the controller", async () => {
            registerBuiltinMethods();
            const controllerCalls: string[] = [];
            const server = makeStubServer(controllerCalls);
            await assert.rejects(
                () =>
                    callMethod("jobs.update", {
                        server,
                        params: { job: builtinJob({ staleDays: 1 }) },
                    }),
                /args\.staleDays must be an integer/,
            );
            assert.deepEqual(controllerCalls, []);
        });

        it("jobs.update refuses builtin: true with a non-built-in command", async () => {
            registerBuiltinMethods();
            const controllerCalls: string[] = [];
            const server = makeStubServer(controllerCalls);
            await assert.rejects(
                () =>
                    callMethod("jobs.update", {
                        server,
                        params: { job: builtinJob({}, "shell.exec") },
                    }),
                /not a built-in command/,
            );
            assert.deepEqual(controllerCalls, []);
        });
    });

    describe("jobs RPC handlers — unsafe IDs (wire-shape)", () => {
        it("jobs.create ignores caller-supplied ids before persistence", async () => {
            registerBuiltinMethods();

            const controllerCalls: string[] = [];
            const server = makeStubServer(controllerCalls);

            // Real wire shape: { job: { ... } }
            await callMethod("jobs.create", {
                server,
                params: {
                    job: {
                        id: "../../etc/passwd",
                        name: "x",
                        schedule: { kind: "interval", ms: 1000 },
                        command: "agent.invoke",
                        args: { workspace: "/tmp/test", prompt: "x" },
                        enabled: true,
                        run_on_startup: false,
                        history: [],
                    },
                },
            });
            assert.deepEqual(controllerCalls, ["create::none"]);
        });

        it("jobs.create strips a valid caller id before reaching the controller", async () => {
            registerBuiltinMethods();

            const controllerCalls: string[] = [];
            const server = makeStubServer(controllerCalls);

            // Positive control: same wire shape, safe id, controller is invoked.
            await callMethod("jobs.create", {
                server,
                params: {
                    job: {
                        id: "nightly-cleanup",
                        name: "x",
                        schedule: { kind: "interval", ms: 1000 },
                        command: "agent.invoke",
                        args: { workspace: "/tmp/test", prompt: "x" },
                        enabled: true,
                        run_on_startup: false,
                        history: [],
                    },
                },
            });
            assert.deepEqual(controllerCalls, ["create::none"]);
        });

        it("jobs.update rejects traversal id before persistence", async () => {
            registerBuiltinMethods();

            const controllerCalls: string[] = [];
            const server = makeStubServer(controllerCalls);

            await assert.rejects(
                () =>
                    callMethod("jobs.update", {
                        server,
                        params: {
                            job: {
                                id: "../escape",
                                name: "x",
                                schedule: { kind: "interval", ms: 1000 },
                                command: "agent.invoke",
                                args: { workspace: "/tmp/test", prompt: "x" },
                                enabled: true,
                                run_on_startup: false,
                                history: [],
                            },
                        },
                    }),
                (e: unknown) =>
                    e instanceof RpcHandlerError &&
                    (e as { code: string }).code === "invalid_params",
            );
            assert.deepEqual(controllerCalls, []);
        });

        it("jobs.delete rejects traversal id without invoking controller", async () => {
            registerBuiltinMethods();

            const controllerCalls: string[] = [];
            const server = makeStubServer(controllerCalls);

            await assert.rejects(
                () => callMethod("jobs.delete", { server, params: { id: "../escape" } }),
                (e: unknown) =>
                    e instanceof RpcHandlerError &&
                    (e as { code: string }).code === "invalid_params",
            );
            assert.deepEqual(controllerCalls, []);
        });

        it("jobs.runNow rejects traversal id without invoking scheduler", async () => {
            registerBuiltinMethods();

            const controllerCalls: string[] = [];
            const server = makeStubServer(controllerCalls);

            await assert.rejects(
                () => callMethod("jobs.runNow", { server, params: { id: "../escape" } }),
                (e: unknown) =>
                    e instanceof RpcHandlerError &&
                    (e as { code: string }).code === "invalid_params",
            );
            assert.deepEqual(controllerCalls, []);
        });

        it("jobs.history rejects traversal id without invoking controller", async () => {
            registerBuiltinMethods();

            const controllerCalls: string[] = [];
            const server = makeStubServer(controllerCalls);

            await assert.rejects(
                () => callMethod("jobs.history", { server, params: { id: "../escape" } }),
                (e: unknown) =>
                    e instanceof RpcHandlerError &&
                    (e as { code: string }).code === "invalid_params",
            );
            assert.deepEqual(controllerCalls, []);
        });
    });

    /**
     * Regression: jobs.* handlers are process-level scheduler RPCs and must NOT
     * require `params.workspace`. Before the fix, `jobs.create/update/delete/runNow`
     * were registered with `ensureWorkspace: true`, so any wire payload that
     * omitted `workspace` was rejected with `missing required field: workspace`
     * by `SidecarServer.executeRpcRequest` — even though the handlers themselves
     * never read the workspace. The Schedules UI never sends `workspace`, so
     * saving a job failed at the wire layer.
     *
     * These tests go through `handleRpcRequest` (the same path real NDJSON
     * traffic hits) and assert the call lands on the controller with the
     * `workspace` parameter absent.
     */

    async function dispatchThroughServer(
        method: string,
        params: unknown,
        controllerCalls: string[],
    ): Promise<RpcResponse> {
        const { SidecarServer } = await import("../../../src/server/server.ts");
        const server = new SidecarServer({ providerKeyStore: {} as never });
        const stubServer = makeStubServer(controllerCalls);
        // SidecarServer stores its own `jobs` reference on construction; replace
        // it with the stub so the handler sees our recording controller. The
        // server never calls any workspace-resolution path here because
        // jobs.* no longer requests one (ensureWorkspace: false).
        server.setJobsControl?.(stubServer.jobs);
        return server.handleRpcRequest({ id: "test-1", method, params } as never);
    }

    describe("jobs RPC — workspace routing (regression)", () => {
        it("jobs.create dispatches without params.workspace", async () => {
            registerBuiltinMethods();
            const controllerCalls: string[] = [];
            const resp = await dispatchThroughServer(
                "jobs.create",
                {
                    job: {
                        id: "nightly-cleanup",
                        name: "x",
                        schedule: { kind: "interval", ms: 1000 },
                        command: "agent.invoke",
                        args: { workspace: "/tmp/test", prompt: "x" },
                        enabled: true,
                        run_on_startup: false,
                        history: [],
                    },
                },
                controllerCalls,
            );
            assert.equal(resp.ok, true, `expected ok, got ${JSON.stringify(resp)}`);
            assert.deepEqual(controllerCalls, ["create::none"]);
        });

        it("jobs.update dispatches without params.workspace", async () => {
            registerBuiltinMethods();
            const controllerCalls: string[] = [];
            const stub = makeStubServer(controllerCalls);
            // Pre-seed via the same stub the server will use so jobs.update's
            // pre-update `get` finds the row. makeStubServer attaches `jobs`
            // unconditionally; the optional chain is just to satisfy the
            // ServerRpcSurface type where `jobs` is optional.
            const jobs = stub.jobs;
            if (!jobs) throw new Error("stub missing jobs");
            await jobs.create({
                id: "nightly-cleanup",
                name: "x",
                schedule: { kind: "interval", ms: 1000 },
                command: "agent.invoke",
                args: { workspace: "/tmp/test", prompt: "x" },
                enabled: true,
                run_on_startup: false,
                history: [],
            });

            const { SidecarServer } = await import("../../../src/server/server.ts");
            const server = new SidecarServer({ providerKeyStore: {} as never });
            server.setJobsControl?.(jobs);
            const resp = await server.handleRpcRequest({
                id: "test-2",
                method: "jobs.update",
                params: {
                    job: {
                        id: "nightly-cleanup",
                        name: "x",
                        schedule: { kind: "interval", ms: 1000 },
                        command: "agent.invoke",
                        args: { workspace: "/tmp/test", prompt: "x" },
                        enabled: true,
                        run_on_startup: false,
                        history: [],
                    },
                },
            } as never);
            assert.equal(resp.ok, true, `expected ok, got ${JSON.stringify(resp)}`);
        });

        it("jobs.delete dispatches without params.workspace", async () => {
            registerBuiltinMethods();
            const controllerCalls: string[] = [];
            const resp = await dispatchThroughServer("jobs.delete", { id: "abc" }, controllerCalls);
            assert.equal(resp.ok, true, `expected ok, got ${JSON.stringify(resp)}`);
        });

        it("jobs.runNow dispatches without params.workspace", async () => {
            registerBuiltinMethods();
            const controllerCalls: string[] = [];
            const resp = await dispatchThroughServer("jobs.runNow", { id: "abc" }, controllerCalls);
            assert.equal(resp.ok, true, `expected ok, got ${JSON.stringify(resp)}`);
        });
    });

    describe("jobs RPC — actor extraction", () => {
        it("passes IM actor through to the controller", async () => {
            registerBuiltinMethods();
            const controllerCalls: string[] = [];
            const server = makeStubServer(controllerCalls);
            await callMethod("jobs.list", {
                server,
                params: {
                    actor: { kind: "im", channelId: "ch1", peerId: "u1", chatId: "c1" },
                },
            });
            assert.deepEqual(controllerCalls, ["list:im"]);
        });

        it("passes IDE actor through to the controller", async () => {
            registerBuiltinMethods();
            const controllerCalls: string[] = [];
            const server = makeStubServer(controllerCalls);
            await callMethod("jobs.list", {
                server,
                params: {
                    actor: { kind: "ide", workspace: "/tmp/proj" },
                },
            });
            assert.deepEqual(controllerCalls, ["list:ide"]);
        });

        it("passes undefined when actor is omitted (legacy / admin callers)", async () => {
            registerBuiltinMethods();
            const controllerCalls: string[] = [];
            const server = makeStubServer(controllerCalls);
            await callMethod("jobs.list", { server, params: {} });
            assert.deepEqual(controllerCalls, ["list:none"]);
        });

        it("treats malformed actor as undefined (admin path)", async () => {
            registerBuiltinMethods();
            const controllerCalls: string[] = [];
            const server = makeStubServer(controllerCalls);
            await callMethod("jobs.list", {
                server,
                params: {
                    actor: { kind: "im", channelId: "ch1" }, // missing peerId/chatId
                },
            });
            assert.deepEqual(controllerCalls, ["list:none"]);
        });
    });
});

describe("memory", () => {
    /**
     * memory.* handlers — happy path and enabled=false path for list/write/deleteTopic;
     * writeMemory conflicts surface as RpcHandlerError("memory.conflict").
     *
     * Run: cd packages/sidecar && pnpm exec tsx --test tests/server/handlers/memory.test.ts
     */

    before(() => {
        registerBuiltinMethods();
    });

    let tmpRoot: string;
    let prevTacoHome: string | undefined;

    beforeEach(() => {
        prevTacoHome = process.env.TACO_HOME;
        tmpRoot = mkdtempSync(join(tmpdir(), "taco-mem-handlers-"));
        process.env.TACO_HOME = tmpRoot;
    });

    afterEach(() => {
        if (prevTacoHome === undefined) Reflect.deleteProperty(process.env, "TACO_HOME");
        else process.env.TACO_HOME = prevTacoHome;
        if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
    });

    const sampleTopic: MemoryEntry = {
        id: "user-role",
        name: "User uses pnpm",
        description: "Project uses pnpm",
        type: "user",
        content: "User said pnpm explicitly.",
        createdAt: "2026-07-29T00:00:00.000Z",
    };

    function makeCtx(workspace: Partial<WorkspaceRuntime>, params: unknown = {}) {
        return {
            id: "test-id",
            workspace: workspace as WorkspaceRuntime,
            cwd: "/tmp/ws",
            server: {},
            params,
        } as unknown as Parameters<
            NonNullable<ReturnType<typeof getRegisteredMethod>>["handler"]
        >[0];
    }

    describe("memory.list", () => {
        it("returns memoryContent + hash + topics + enabled=true for LocalMemoryStore", async () => {
            const store = new LocalMemoryStore();
            store.initialize("ws-test");
            await store.appendEntry(sampleTopic);

            const handler = getRegisteredMethod("memory.list");
            assert.ok(handler);
            const result = (await handler.handler(makeCtx({ memoryStore: store }))) as {
                memoryContent: string;
                memoryHash: string;
                topics: { id: string }[];
                enabled: boolean;
            };

            assert.equal(result.enabled, true);
            assert.equal(result.memoryHash, hashOf(result.memoryContent));
            assert.equal(result.topics.length, 1);
            assert.equal(result.topics[0]?.id, "user-role");
        });

        it("returns enabled=false when store is NoOpMemoryStore", async () => {
            const store = new NoOpMemoryStore();
            store.initialize("ws-test");

            const handler = getRegisteredMethod("memory.list");
            assert.ok(handler);
            const result = (await handler.handler(makeCtx({ memoryStore: store }))) as {
                memoryContent: string;
                topics: unknown[];
                enabled: boolean;
            };

            assert.equal(result.enabled, false);
            assert.equal(result.memoryContent, "");
            assert.deepEqual(result.topics, []);
        });
    });

    describe("memory.write", () => {
        it("writes new content when baseHash matches", async () => {
            const store = new LocalMemoryStore();
            store.initialize("ws-test");
            const baseline = store.readMemory();
            const baseHash = hashOf(baseline);
            const newContent = `${baseline}\n## [2026-07-29T00:00:00.000Z] user\n\nmanual\n`;

            const handler = getRegisteredMethod("memory.write");
            assert.ok(handler);
            const ctx = makeCtx(
                { memoryStore: store },
                { workspace: "/tmp/ws", content: newContent, baseHash },
            );
            const result = (await handler.handler(ctx)) as { ok: true };

            assert.deepEqual(result, { ok: true });
            assert.equal(store.readMemory(), newContent);
        });

        it("translates MemoryConflictError to RpcHandlerError memory.conflict with current data", async () => {
            const store = new LocalMemoryStore();
            store.initialize("ws-test");
            const baseline = store.readMemory();
            const staleHash = hashOf(baseline);

            // First write to advance the hash
            await store.writeMemory(`${baseline}\n## [...] first\n`, staleHash);
            const currentContent = store.readMemory();
            const currentHash = hashOf(currentContent);

            // Second write with a stale hash
            const handler = getRegisteredMethod("memory.write");
            assert.ok(handler);
            const ctx = makeCtx(
                { memoryStore: store },
                {
                    workspace: "/tmp/ws",
                    content: `${baseline}\n## [...] second\n`,
                    baseHash: staleHash,
                },
            );

            await assert.rejects(
                () => handler.handler(ctx),
                (err: unknown) => {
                    assert.ok(err instanceof Error);
                    assert.equal((err as { code?: string }).code, "memory.conflict");
                    const data = (err as { data?: unknown }).data as {
                        currentContent: string;
                        currentHash: string;
                    };
                    assert.equal(data.currentContent, currentContent);
                    assert.equal(data.currentHash, currentHash);
                    return true;
                },
            );
        });
    });

    describe("memory.upsert", () => {
        it("add creates a new topic and returns outcome=created", async () => {
            const store = new LocalMemoryStore();
            store.initialize("ws-test");
            const handler = getRegisteredMethod("memory.upsert");
            assert.ok(handler);

            const ctx = makeCtx(
                { memoryStore: store },
                {
                    workspace: "/tmp/ws",
                    action: "add",
                    id: "new-topic",
                    name: "New Topic",
                    content: "body",
                    type: "user",
                },
            );
            const result = (await handler.handler(ctx)) as {
                ok: true;
                outcome: "created" | "updated" | "deleted";
            };

            assert.deepEqual(result, { ok: true, outcome: "created" });
            assert.equal(store.getTopic("new-topic")?.content, "body");
        });

        it("add fails with id_conflict when id already exists", async () => {
            const store = new LocalMemoryStore();
            store.initialize("ws-test");
            await store.appendEntry(sampleTopic);

            const handler = getRegisteredMethod("memory.upsert");
            assert.ok(handler);
            const ctx = makeCtx(
                { memoryStore: store },
                {
                    workspace: "/tmp/ws",
                    action: "add",
                    id: "user-role",
                    name: "Dup",
                    content: "dup body",
                    type: "user",
                },
            );

            await assert.rejects(
                () => handler.handler(ctx),
                (err: unknown) => {
                    assert.ok(err instanceof Error);
                    assert.equal((err as { code?: string }).code, "id_conflict");
                    return true;
                },
            );
        });

        it("replace updates content and returns outcome=updated", async () => {
            const store = new LocalMemoryStore();
            store.initialize("ws-test");
            await store.appendEntry(sampleTopic);

            const handler = getRegisteredMethod("memory.upsert");
            assert.ok(handler);
            const ctx = makeCtx(
                { memoryStore: store },
                {
                    workspace: "/tmp/ws",
                    action: "replace",
                    id: "user-role",
                    content: "new body",
                },
            );
            const result = (await handler.handler(ctx)) as {
                ok: true;
                outcome: "created" | "updated" | "deleted";
            };
            assert.equal(result.outcome, "updated");
            assert.equal(store.getTopic("user-role")?.content, "new body");
        });

        it("replace refuses empty or oversized content", async () => {
            const store = new LocalMemoryStore();
            store.initialize("ws-test");
            await store.appendEntry(sampleTopic);
            const handler = getRegisteredMethod("memory.upsert");
            assert.ok(handler);
            for (const content of ["", "   ", "x".repeat(1001), 42]) {
                await assert.rejects(
                    Promise.resolve().then(() =>
                        handler.handler(
                            makeCtx(
                                { memoryStore: store },
                                {
                                    workspace: "/tmp/ws",
                                    action: "replace",
                                    id: "user-role",
                                    content,
                                },
                            ),
                        ),
                    ),
                    /content required/,
                );
            }
            assert.equal(store.getTopic("user-role")?.content, sampleTopic.content);
        });

        it("deleteTopic refuses when the topic changed since the client showed it", async () => {
            const store = new LocalMemoryStore();
            store.initialize("ws-test");
            await store.appendEntry(sampleTopic);
            const handler = getRegisteredMethod("memory.deleteTopic");
            assert.ok(handler);
            await assert.rejects(
                Promise.resolve().then(() =>
                    handler.handler(
                        makeCtx(
                            { memoryStore: store },
                            { workspace: "/tmp/ws", id: "user-role", expectedContent: "stale" },
                        ),
                    ),
                ),
                /changed since it was read/,
            );
            assert.ok(store.getTopic("user-role"), "a stale delete leaves the topic in place");
            await handler.handler(
                makeCtx(
                    { memoryStore: store },
                    {
                        workspace: "/tmp/ws",
                        id: "user-role",
                        expectedContent: store.getTopic("user-role")?.content,
                    },
                ),
            );
            assert.equal(store.getTopic("user-role"), undefined);
        });

        it("replace writes updatedAt so listTopics wire response includes it", async () => {
            const store = new LocalMemoryStore();
            store.initialize("ws-test");
            await store.appendEntry(sampleTopic);

            const upsertHandler = getRegisteredMethod("memory.upsert");
            assert.ok(upsertHandler);
            await upsertHandler.handler(
                makeCtx(
                    { memoryStore: store },
                    { workspace: "/tmp/ws", action: "replace", id: "user-role", content: "v2" },
                ),
            );

            const listHandler = getRegisteredMethod("memory.list");
            assert.ok(listHandler);
            const listResult = (await listHandler.handler(makeCtx({ memoryStore: store }))) as {
                topics: Array<{ id: string; updatedAt?: string }>;
            };

            const topic = listResult.topics.find((t) => t.id === "user-role");
            assert.ok(topic);
            assert.equal(typeof topic.updatedAt, "string");
            assert.ok(topic.updatedAt && topic.updatedAt.length > 0);
        });

        it("replace fails for unknown id", async () => {
            const store = new LocalMemoryStore();
            store.initialize("ws-test");

            const handler = getRegisteredMethod("memory.upsert");
            assert.ok(handler);
            const ctx = makeCtx(
                { memoryStore: store },
                {
                    workspace: "/tmp/ws",
                    action: "replace",
                    id: "does-not-exist",
                    content: "x",
                },
            );

            await assert.rejects(() => handler.handler(ctx), /unknown memory topic/);
        });

        it("remove deletes the topic and returns outcome=deleted", async () => {
            const store = new LocalMemoryStore();
            store.initialize("ws-test");
            await store.appendEntry(sampleTopic);

            const handler = getRegisteredMethod("memory.upsert");
            assert.ok(handler);
            const ctx = makeCtx(
                { memoryStore: store },
                {
                    workspace: "/tmp/ws",
                    action: "remove",
                    id: "user-role",
                },
            );
            const result = (await handler.handler(ctx)) as {
                ok: true;
                outcome: "created" | "updated" | "deleted";
            };
            assert.equal(result.outcome, "deleted");
            assert.equal(store.getTopic("user-role"), undefined);
        });

        it("rejects id with uppercase, path traversal, underscores, or over-length", async () => {
            const store = new LocalMemoryStore();
            store.initialize("ws-test");
            const handler = getRegisteredMethod("memory.upsert");
            assert.ok(handler);

            for (const badId of [
                "../etc/passwd",
                "UPPER",
                "with space",
                "my_id",
                "x".repeat(65),
                "",
            ]) {
                const ctx = makeCtx(
                    { memoryStore: store },
                    {
                        workspace: "/tmp/ws",
                        action: "add",
                        id: badId,
                        name: "x",
                        content: "x",
                        type: "user",
                    },
                );
                await assert.rejects(
                    () => handler.handler(ctx),
                    (err: unknown) => {
                        assert.ok(err instanceof Error);
                        assert.equal((err as { code?: string }).code, "invalid_params");
                        return true;
                    },
                    `bad id "${badId}" must be rejected`,
                );
            }
        });

        it("rejects non-string id with invalid_params", async () => {
            const store = new LocalMemoryStore();
            store.initialize("ws-test");
            const handler = getRegisteredMethod("memory.upsert");
            assert.ok(handler);

            for (const badId of [null, undefined, 123, {}, []]) {
                const ctx = makeCtx(
                    { memoryStore: store },
                    {
                        workspace: "/tmp/ws",
                        action: "add",
                        id: badId,
                        name: "x",
                        content: "x",
                        type: "user",
                    },
                );
                await assert.rejects(
                    () => handler.handler(ctx),
                    (err: unknown) => {
                        assert.ok(err instanceof Error);
                        assert.equal((err as { code?: string }).code, "invalid_params");
                        return true;
                    },
                    `non-string id ${JSON.stringify(badId)} must be rejected`,
                );
            }
        });

        it("rejects add with name > 60 or content over the content cap", async () => {
            const store = new LocalMemoryStore();
            store.initialize("ws-test");
            const handler = getRegisteredMethod("memory.upsert");
            assert.ok(handler);

            const badCases: Array<{ name?: string; content?: string }> = [
                { name: "x".repeat(61), content: "ok" },
                { name: "ok", content: "x".repeat(MEMORY_CONTENT_MAX_CHARS + 1) },
            ];
            for (const overrides of badCases) {
                const ctx = makeCtx(
                    { memoryStore: store },
                    {
                        workspace: "/tmp/ws",
                        action: "add",
                        id: "valid-id",
                        name: "ok",
                        content: "ok",
                        type: "user",
                        ...overrides,
                    },
                );
                await assert.rejects(
                    () => handler.handler(ctx),
                    (err: unknown) => {
                        assert.ok(err instanceof Error);
                        assert.equal((err as { code?: string }).code, "invalid_params");
                        return true;
                    },
                    `oversized ${JSON.stringify(overrides)} must reject`,
                );
            }
        });

        it("add uses explicit description when provided, falls back to name", async () => {
            const store = new LocalMemoryStore();
            store.initialize("ws-test");
            const handler = getRegisteredMethod("memory.upsert");
            assert.ok(handler);

            // With explicit description
            const ctx1 = makeCtx(
                { memoryStore: store },
                {
                    workspace: "/tmp/ws",
                    action: "add",
                    id: "with-desc",
                    name: "Name",
                    description: "Custom desc",
                    content: "body",
                    type: "user",
                },
            );
            await handler.handler(ctx1);
            assert.equal(store.getTopic("with-desc")?.description, "Custom desc");

            // Without description → falls back to name
            const ctx2 = makeCtx(
                { memoryStore: store },
                {
                    workspace: "/tmp/ws",
                    action: "add",
                    id: "no-desc",
                    name: "Name",
                    content: "body",
                    type: "feedback",
                },
            );
            await handler.handler(ctx2);
            assert.equal(store.getTopic("no-desc")?.description, "Name");
        });
    });

    describe("memory.dream* (preview → apply → undo)", () => {
        const topics = (n: number): MemoryEntry[] =>
            Array.from({ length: n }, (_, i) => ({
                ...sampleTopic,
                id: `t${i}`,
                name: `T${i}`,
                content: `fact ${i}`,
            }));

        const plan = {
            actions: [
                {
                    action: "merge",
                    sourceIds: ["t0", "t1"],
                    id: "t01",
                    name: "T01",
                    description: "merged",
                    type: "user",
                    content: "fact 0 and 1",
                },
                { action: "rewrite", id: "t2", content: "fact 2, tightened" },
            ],
        };

        function workspaceWith(store: LocalMemoryStore, response: unknown = plan) {
            let calls = 0;
            const model = { provider: "faux", id: "m" };
            const models = {
                completeSimple: async () => {
                    calls++;
                    return {
                        role: "assistant",
                        content: [{ type: "text", text: JSON.stringify(response) }],
                    };
                },
                getModel: () => undefined,
                getModels: () => [model],
            };
            return {
                workspace: {
                    memoryStore: store,
                    models,
                    defaultModel: model,
                } as unknown as Partial<WorkspaceRuntime>,
                calls: () => calls,
            };
        }

        async function call(
            method: string,
            workspace: Partial<WorkspaceRuntime>,
            params: unknown = {},
        ) {
            const handler = getRegisteredMethod(method);
            assert.ok(handler, `${method} is registered`);
            return handler.handler(
                makeCtx(workspace, { workspace: "/tmp/ws", ...(params as object) }),
            );
        }

        async function seeded(n = 10): Promise<LocalMemoryStore> {
            const store = new LocalMemoryStore();
            store.initialize("ws-dream");
            for (const topic of topics(n)) await store.appendEntry(topic);
            return store;
        }

        it("dreamRun previews without touching memory; memory.list carries the preview", async () => {
            const store = await seeded();
            const { workspace } = workspaceWith(store);
            const run = (await call("memory.dreamRun", workspace)) as {
                status: string;
                preview: { id: string; counts: { merged: number } };
            };
            assert.equal(run.status, "previewed");
            assert.equal(run.preview.counts.merged, 2);
            assert.equal(store.getTopic("t2")?.content, "fact 2");

            const list = (await call("memory.list", workspace)) as {
                dream?: { pending?: { id: string }; confirmed: boolean };
            };
            assert.equal(list.dream?.pending?.id, run.preview.id);
            assert.equal(list.dream?.confirmed, false);
        });

        it("dreamApply requires the reviewed preview id, then applies and confirms", async () => {
            const store = await seeded();
            const { workspace } = workspaceWith(store);
            const run = (await call("memory.dreamRun", workspace)) as { preview: { id: string } };

            await assert.rejects(
                () => call("memory.dreamApply", workspace, { previewId: "stale-id" }),
                /preview changed/,
            );
            const applied = (await call("memory.dreamApply", workspace, {
                previewId: run.preview.id,
            })) as { report: { id: string; skipped: number } };
            assert.equal(applied.report.skipped, 0);
            assert.equal(store.getTopic("t01")?.content, "fact 0 and 1");
            assert.equal(store.getTopic("t0"), undefined);

            const list = (await call("memory.list", workspace)) as {
                dream?: {
                    pending?: unknown;
                    confirmed: boolean;
                    reports: Array<{ id: string }>;
                    archived: Array<{ id: string }>;
                };
            };
            assert.equal(list.dream?.pending, undefined);
            assert.equal(list.dream?.confirmed, true);
            assert.deepEqual(
                list.dream?.reports.map((r) => r.id),
                [applied.report.id],
            );
            assert.deepEqual(list.dream?.archived.map((t) => t.id).sort(), ["t0", "t1"]);
        });

        it("manual dreamRun previews even for a confirmed workspace", async () => {
            const store = await seeded();
            const { workspace } = workspaceWith(store);
            const first = (await call("memory.dreamRun", workspace)) as { preview: { id: string } };
            await call("memory.dreamApply", workspace, { previewId: first.preview.id });

            const { workspace: again } = workspaceWith(store, {
                actions: [{ action: "rewrite", id: "t3", content: "fact 3 v2" }],
            });
            const second = (await call("memory.dreamRun", again)) as { status: string };
            assert.equal(second.status, "previewed");
            assert.equal(store.getTopic("t3")?.content, "fact 3");
        });

        it("dreamDiscard drops the preview", async () => {
            const store = await seeded();
            const { workspace } = workspaceWith(store);
            await call("memory.dreamRun", workspace);
            await call("memory.dreamDiscard", workspace);
            const list = (await call("memory.list", workspace)) as {
                dream?: { pending?: unknown };
            };
            assert.equal(list.dream?.pending, undefined);
        });

        it("dreamUndo reverts an applied run and reports later conflicts", async () => {
            const store = await seeded();
            const { workspace } = workspaceWith(store);
            const run = (await call("memory.dreamRun", workspace)) as { preview: { id: string } };
            const applied = (await call("memory.dreamApply", workspace, {
                previewId: run.preview.id,
            })) as { report: { id: string } };
            await store.updateTopic("t2", "edited after the run");

            const undo = (await call("memory.dreamUndo", workspace, {
                reportId: applied.report.id,
            })) as { conflicts: string[] };
            assert.deepEqual(undo.conflicts, ["t2"]);
            assert.equal(store.getTopic("t0")?.content, "fact 0");
            assert.equal(
                store.getTopic("t2")?.content,
                "edited after the run",
                "a later edit wins",
            );
            await assert.rejects(
                () => call("memory.dreamUndo", workspace, { reportId: applied.report.id }),
                /already undone/,
            );
        });

        it("restoreTopic brings an archived topic back", async () => {
            const store = await seeded(3);
            await store.archiveTopic("t1");
            const { workspace } = workspaceWith(store);
            await call("memory.restoreTopic", workspace, { id: "t1" });
            assert.ok(store.getTopic("t1"));
            await assert.rejects(
                () => call("memory.restoreTopic", workspace, { id: "t1" }),
                /unknown archived/,
            );
        });

        it("dreamRun rejects an unknown model override instead of falling back", async () => {
            const store = await seeded();
            const { workspace } = workspaceWith(store);
            const handler = getRegisteredMethod("memory.dreamRun");
            assert.ok(handler);
            const ctx = makeCtx(workspace);
            (ctx as { server?: unknown }).server = {
                jobs: { get: async () => ({ args: { model: "missing/model" } }) },
            };
            await assert.rejects(() => handler.handler(ctx), /model not found: missing\/model/);
        });

        it("dreamRun with too few topics skips without a model call", async () => {
            const store = await seeded(2);
            const { workspace, calls } = workspaceWith(store);
            const run = (await call("memory.dreamRun", workspace)) as { status: string };
            assert.equal(run.status, "skipped");
            assert.equal(calls(), 0);
        });

        it("the dream surface refuses a disabled memory store", async () => {
            const { workspace } = workspaceWith(new LocalMemoryStore());
            const disabled = { ...workspace, memoryStore: new NoOpMemoryStore() };
            await assert.rejects(() => call("memory.dreamRun", disabled), /memory is disabled/);
            const list = (await call("memory.list", disabled)) as { dream?: unknown };
            assert.equal(list.dream, undefined);
        });
    });
});
