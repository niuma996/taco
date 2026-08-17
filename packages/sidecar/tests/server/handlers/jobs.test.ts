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
    const jobs = {
        list: async () => {
            controllerCalls.push("list");
            return [];
        },
        get: async (id: string) => {
            controllerCalls.push(`get:${id}`);
            return null;
        },
        create: async (job: unknown) => {
            controllerCalls.push(`create:${(job as { id?: string }).id ?? "?"}`);
            return job;
        },
        update: async (job: unknown) => {
            controllerCalls.push(`update:${(job as { id?: string }).id ?? "?"}`);
            return job;
        },
        delete: async (id: string) => {
            controllerCalls.push(`delete:${id}`);
        },
        runNow: async (id: string) => {
            controllerCalls.push(`runNow:${id}`);
            return true;
        },
        history: async () => {
            controllerCalls.push("history");
            return null;
        },
    };
    return { jobs } as unknown as AnyServer;
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
    it("jobs.create rejects traversal id before persistence", async () => {
        registerBuiltinMethods();
        const reg = getRegisteredMethod("jobs.create");
        assert.ok(reg);

        const controllerCalls: string[] = [];
        const server = makeStubServer(controllerCalls);

        // Real wire shape: { job: { ... } }
        await assert.rejects(
            () =>
                reg.handler(
                    makeCtx(server, {
                        job: {
                            id: "../../etc/passwd",
                            name: "x",
                            schedule: { kind: "interval", ms: 1000 },
                            command: "agent.invoke",
                            args: {},
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

    it("jobs.create accepts a valid id long enough to reach the controller", async () => {
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
                    args: {},
                    enabled: true,
                    run_on_startup: false,
                    history: [],
                },
            }),
        );
        assert.deepEqual(controllerCalls, ["create:nightly-cleanup"]);
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
                            args: {},
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
