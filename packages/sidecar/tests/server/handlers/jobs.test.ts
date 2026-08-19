/**
 * jobs.* handler — unsafe-ID validation tests.
 *
 * The handler signature is `MethodCtx<JobsXxxParams>` and `params` in
 * that ctx IS the wire body. For `jobs.create`, the desktop client sends
 * `call(client, JOBS_RPC.create, { job })` (see
 * `clients/taco-desktop/src/lib/jobsClient.ts`), so on the server
 * `params = { job: { ... } }`. The same shape applies to
 * `jobs.update` (also a `{ job }` wrapper). `jobs.delete` /
 * `jobs.run_now` / `jobs.history` / `jobs.get` use a flat `{ id }`
 * payload — their `params` is `{ id }` directly.
 *
 * The previous test wrapped each input in a redundant
 * `params: { workspace, params: { job: ... } }` shell that does not
 * match real wire traffic. With that shell, `assertJob(params, "job")`
 * reads `params["job"]` = the inner `{ job: ... }` wrapper, throws on
 * the missing `obj.id`, and `assertSafeJobId` never runs — the test was
 * passing for the wrong reason.
 *
 * These tests use the real wire shape so the asserted contract is the
 * one callers actually depend on.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { getRegisteredMethod, RpcHandlerError } from "../../../src/server/methodRegistry.ts";
import { registerBuiltinMethods } from "../../../src/server/methods.ts";

type AnyServer = Parameters<
    NonNullable<ReturnType<typeof getRegisteredMethod>>["handler"]
>[0]["server"];
type Ctx = Parameters<NonNullable<ReturnType<typeof getRegisteredMethod>>["handler"]>[0];

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

function makeCtx(server: AnyServer, params: unknown): Ctx {
    return {
        id: "test",
        workspace: undefined as never,
        cwd: undefined as never,
        server,
        params,
    } as Ctx;
}

describe("jobs RPC handlers — unsafe IDs (wire-shape)", () => {
    it("jobs.create ignores caller-supplied ids before persistence", async () => {
        registerBuiltinMethods();
        const reg = getRegisteredMethod("jobs.create");
        assert.ok(reg);

        const controllerCalls: string[] = [];
        const server = makeStubServer(controllerCalls);

        // Real wire shape: { job: { ... } }
        await reg.handler(
            makeCtx(server, {
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
            }),
        );
        assert.deepEqual(controllerCalls, ["create::none"]);
    });

    it("jobs.create strips a valid caller id before reaching the controller", async () => {
        registerBuiltinMethods();
        const reg = getRegisteredMethod("jobs.create");
        assert.ok(reg);

        const controllerCalls: string[] = [];
        const server = makeStubServer(controllerCalls);

        // Positive control: same wire shape, safe id, controller is invoked.
        await reg.handler(
            makeCtx(server, {
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
            }),
        );
        assert.deepEqual(controllerCalls, ["create::none"]);
    });

    it("jobs.update rejects traversal id before persistence", async () => {
        registerBuiltinMethods();
        const reg = getRegisteredMethod("jobs.update");
        assert.ok(reg);

        const controllerCalls: string[] = [];
        const server = makeStubServer(controllerCalls);

        await assert.rejects(
            () =>
                reg.handler(
                    makeCtx(server, {
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
                    }),
                ),
            (e: unknown) =>
                e instanceof RpcHandlerError && (e as { code: string }).code === "invalid_params",
        );
        assert.deepEqual(controllerCalls, []);
    });

    it("jobs.delete rejects traversal id without invoking controller", async () => {
        registerBuiltinMethods();
        const reg = getRegisteredMethod("jobs.delete");
        assert.ok(reg);

        const controllerCalls: string[] = [];
        const server = makeStubServer(controllerCalls);

        await assert.rejects(
            () => reg.handler(makeCtx(server, { id: "../escape" })),
            (e: unknown) =>
                e instanceof RpcHandlerError && (e as { code: string }).code === "invalid_params",
        );
        assert.deepEqual(controllerCalls, []);
    });

    it("jobs.run_now rejects traversal id without invoking scheduler", async () => {
        registerBuiltinMethods();
        const reg = getRegisteredMethod("jobs.run_now");
        assert.ok(reg);

        const controllerCalls: string[] = [];
        const server = makeStubServer(controllerCalls);

        await assert.rejects(
            () => reg.handler(makeCtx(server, { id: "../escape" })),
            (e: unknown) =>
                e instanceof RpcHandlerError && (e as { code: string }).code === "invalid_params",
        );
        assert.deepEqual(controllerCalls, []);
    });

    it("jobs.history rejects traversal id without invoking controller", async () => {
        registerBuiltinMethods();
        const reg = getRegisteredMethod("jobs.history");
        assert.ok(reg);

        const controllerCalls: string[] = [];
        const server = makeStubServer(controllerCalls);

        await assert.rejects(
            () => reg.handler(makeCtx(server, { id: "../escape" })),
            (e: unknown) =>
                e instanceof RpcHandlerError && (e as { code: string }).code === "invalid_params",
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

import type { RpcResponse } from "@taco-ai/protocol";

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

    it("jobs.run_now dispatches without params.workspace", async () => {
        registerBuiltinMethods();
        const controllerCalls: string[] = [];
        const resp = await dispatchThroughServer("jobs.run_now", { id: "abc" }, controllerCalls);
        assert.equal(resp.ok, true, `expected ok, got ${JSON.stringify(resp)}`);
    });
});

describe("jobs RPC — actor extraction", () => {
    it("passes IM actor through to the controller", async () => {
        registerBuiltinMethods();
        const reg = getRegisteredMethod("jobs.list");
        assert.ok(reg);
        const controllerCalls: string[] = [];
        const server = makeStubServer(controllerCalls);
        await reg.handler(
            makeCtx(server, {
                actor: { kind: "im", channelId: "ch1", peerId: "u1", chatId: "c1" },
            }),
        );
        assert.deepEqual(controllerCalls, ["list:im"]);
    });

    it("passes IDE actor through to the controller", async () => {
        registerBuiltinMethods();
        const reg = getRegisteredMethod("jobs.list");
        assert.ok(reg);
        const controllerCalls: string[] = [];
        const server = makeStubServer(controllerCalls);
        await reg.handler(
            makeCtx(server, {
                actor: { kind: "ide", workspace: "/tmp/proj" },
            }),
        );
        assert.deepEqual(controllerCalls, ["list:ide"]);
    });

    it("passes undefined when actor is omitted (legacy / admin callers)", async () => {
        registerBuiltinMethods();
        const reg = getRegisteredMethod("jobs.list");
        assert.ok(reg);
        const controllerCalls: string[] = [];
        const server = makeStubServer(controllerCalls);
        await reg.handler(makeCtx(server, {}));
        assert.deepEqual(controllerCalls, ["list:none"]);
    });

    it("treats malformed actor as undefined (admin path)", async () => {
        registerBuiltinMethods();
        const reg = getRegisteredMethod("jobs.list");
        assert.ok(reg);
        const controllerCalls: string[] = [];
        const server = makeStubServer(controllerCalls);
        await reg.handler(
            makeCtx(server, {
                actor: { kind: "im", channelId: "ch1" }, // missing peerId/chatId
            }),
        );
        assert.deepEqual(controllerCalls, ["list:none"]);
    });
});
