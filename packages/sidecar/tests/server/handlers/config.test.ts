/**
 * config.* handlers — the approval gate.
 *
 * The handler is where a model-proposed config change becomes a real write,
 * so these tests pin the two properties that matter: nothing is written
 * without an approval, and the reason for a denial reaches the caller (the
 * tool turns it into guidance, and "the user said no" and "nobody answered"
 * call for different behaviour).
 *
 * Run: cd packages/sidecar && pnpm exec tsx --test tests/server/handlers/config.test.ts
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, before, beforeEach, describe, it } from "node:test";

import type { ConfigPatchResult } from "@taco-ai/protocol";
import { PermissionBroker } from "../../../src/permissions/permissionBroker.ts";
import type { WorkspaceRuntime } from "../../../src/runtime/workspace.ts";
import { getRegisteredMethod } from "../../../src/server/methodRegistry.ts";
import { registerBuiltinMethods } from "../../../src/server/methods.ts";

before(() => {
    registerBuiltinMethods();
});

let tmpRoot: string;
let prevTacoHome: string | undefined;

beforeEach(() => {
    prevTacoHome = process.env.TACO_HOME;
    tmpRoot = mkdtempSync(join(tmpdir(), "taco-config-handlers-"));
    process.env.TACO_HOME = tmpRoot;
});

afterEach(() => {
    if (prevTacoHome === undefined) Reflect.deleteProperty(process.env, "TACO_HOME");
    else process.env.TACO_HOME = prevTacoHome;
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * A broker whose requests are answered by the test. `answer` decides what the
 * user does; a request that is never answered times out, so the test must
 * always answer.
 */
function makeBroker(answer: (requestId: string) => void): PermissionBroker {
    const broker = new PermissionBroker(() => ({ mode: "ask" }) as const);
    broker.on("requested", (request) => {
        // The approval is a prompt the user sees; answer it on the next tick
        // so the request is registered before it is resolved.
        setImmediate(() => answer(request.requestId));
    });
    return broker;
}

function makeCtx(workspace: Partial<WorkspaceRuntime>, params: unknown) {
    return {
        id: "test-id",
        workspace: workspace as WorkspaceRuntime,
        cwd: "/tmp/ws",
        server: { providerKeyStore: { update: () => {} } },
        serverRegistry: undefined,
        params,
    } as unknown as Parameters<NonNullable<ReturnType<typeof getRegisteredMethod>>["handler"]>[0];
}

const patchParams = {
    workspace: "/tmp/ws",
    sessionId: "s1",
    toolCallId: "tc1",
    patch: { defaultModel: "claude-opus-5" },
};

describe("config.patch", () => {
    it("writes nothing and reports the user's denial", async () => {
        const broker = makeBroker((requestId) => {
            broker.resolve(requestId, false, "once");
        });
        const handler = getRegisteredMethod("config.patch");
        assert.ok(handler);

        const result = (await handler.handler(
            makeCtx({ permissionBroker: broker }, patchParams),
        )) as ConfigPatchResult;

        assert.equal(result.approved, false);
        assert.deepEqual(result.fields, ["defaultModel"]);
        // The reason has to survive: the tool tells the model not to retry on a
        // user denial, but that asking is fine on a timeout.
        assert.equal(result.denialReason, "user_denied");
    });

    it("reports a missing approver separately from a user denial", async () => {
        const broker = new PermissionBroker(() => ({ mode: "ask" }) as const, {
            hasApprover: () => false,
        });
        const handler = getRegisteredMethod("config.patch");
        assert.ok(handler);

        const result = (await handler.handler(
            makeCtx({ permissionBroker: broker }, patchParams),
        )) as ConfigPatchResult;

        assert.equal(result.approved, false);
        assert.equal(result.denialReason, "no_approver");
    });

    it("refuses an empty patch", async () => {
        const broker = makeBroker(() => {});
        const handler = getRegisteredMethod("config.patch");
        assert.ok(handler);

        await assert.rejects(
            () =>
                handler.handler(
                    makeCtx(
                        { permissionBroker: broker },
                        {
                            ...patchParams,
                            patch: {},
                        },
                    ),
                ),
            /touches no fields/,
        );
    });
});
