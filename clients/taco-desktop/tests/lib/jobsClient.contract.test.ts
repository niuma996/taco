import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderKeyStore } from "../../../../packages/sidecar/src/runtime/models/providerKeyStore.ts";
import { SidecarServer } from "../../../../packages/sidecar/src/server/server.ts";
import { createJobsClient } from "../../src/lib/clients/jobsClient.ts";

test("jobs client carries actor and id-free create through real server schemas", async () => {
    const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
    const actors: unknown[] = [];
    const job = {
        id: "job-1",
        name: "x",
        schedule: { kind: "interval" as const, ms: 1000 },
        command: "agent.invoke",
        args: { workspace: "/w", prompt: "hello" },
        enabled: true,
        run_on_startup: false,
        history: [],
    };
    server.setJobsControl({
        list: async (actor: unknown) => {
            actors.push(actor);
            return [job];
        },
        get: async () => job,
        create: async (_job: unknown, actor: unknown) => {
            actors.push(actor);
            return job;
        },
    } as unknown as NonNullable<typeof server.jobs>);
    const client = {
        callProcess: async <P, R>(method: string, params: P): Promise<R> => {
            const request = JSON.parse(JSON.stringify({ id: "jobs", method, params }));
            const response = await server.dispatchRpc(request);
            if (!response.ok) throw new Error(response.error.code);
            return JSON.parse(JSON.stringify(response.result)) as R;
        },
    };
    const jobs = createJobsClient(client);
    const actor = { kind: "ide" as const, workspace: "/w" };
    assert.deepEqual(await jobs.list(actor), [job]);
    const { id: _id, ...create } = job;
    assert.deepEqual(await jobs.create(create, actor), job);
    assert.deepEqual(actors, [actor, actor]);
    await assert.rejects(jobs.get("../escape", actor), /invalid_params/);
});
