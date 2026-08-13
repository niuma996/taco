/**
 * session.prompt / session.submitAnswers busy-path tests.
 *
 * Two ways a turn can be refused, both of which used to reach the client as an
 * unactionable `internal` error:
 *   - an in-flight compaction never settles → the handler must not call prompt()
 *     at all (pi would throw its own busy from the `compaction` phase)
 *   - pi throws AgentHarnessError("busy") → must be translated, since
 *     normalizeError only preserves the code of an RpcHandlerError
 *
 * Stub workspace / attached, same pattern as session.compactionHandlers.test.ts.
 */

import { strict as assert } from "node:assert";
import { before, describe, it } from "node:test";
import { AgentHarnessError } from "@earendil-works/pi-agent-core";

import { getRegisteredMethod, RpcHandlerError } from "../../../src/server/methodRegistry.ts";
import { registerBuiltinMethods } from "../../../src/server/methods.ts";

before(() => {
    registerBuiltinMethods();
});

type Handler = NonNullable<ReturnType<typeof getRegisteredMethod>>["handler"];
type Ctx = Parameters<Handler>[0];

/**
 * Build a handler ctx whose compaction gate and prompt() are both scriptable.
 * `settled: false` models a compaction that outlives the wait.
 */
function makeCtx(opts: {
    settled: boolean;
    prompt: () => Promise<unknown>;
    params?: Record<string, unknown>;
}): { ctx: Ctx; promptCalls: () => number } {
    let promptCalls = 0;
    const attached = {
        session: { appendSessionName: async () => undefined },
        prompt: (...args: unknown[]) => {
            promptCalls++;
            void args;
            return opts.prompt();
        },
    };
    const workspace = {
        getAttached: () => attached,
        attach: async () => attached,
        invalidateListCache: () => undefined,
    };
    const ctx = {
        id: "test-id",
        workspace,
        cwd: "/tmp/ws",
        server: {
            awaitCompactionEnd: async () => opts.settled,
        },
        params: {
            workspace: "/tmp/ws",
            sessionId: "sid",
            text: "hello",
            ...opts.params,
        },
    } as unknown as Ctx;
    return { ctx, promptCalls: () => promptCalls };
}

function isSessionBusy(e: unknown): boolean {
    return e instanceof RpcHandlerError && e.code === "session_busy";
}

describe("session.prompt busy paths", () => {
    it("returns session_busy without prompting when compaction never settles", async () => {
        const { ctx, promptCalls } = makeCtx({
            settled: false,
            prompt: async () => ({ role: "assistant", content: "unreachable" }),
        });
        const method = getRegisteredMethod("session.prompt");
        assert.ok(method);

        await assert.rejects(method.handler(ctx), isSessionBusy);
        // Load-bearing: proceeding anyway is exactly the old bug — pi would be in
        // its `compaction` phase and throw a busy the client cannot classify.
        assert.equal(promptCalls(), 0, "must not start a turn while compacting");
    });

    it("translates pi's AgentHarnessError(busy) into session_busy", async () => {
        const { ctx } = makeCtx({
            settled: true,
            prompt: async () => {
                throw new AgentHarnessError("busy", "AgentHarness is busy");
            },
        });
        const method = getRegisteredMethod("session.prompt");
        assert.ok(method);

        await assert.rejects(method.handler(ctx), isSessionBusy);
    });

    it("leaves non-busy harness errors alone", async () => {
        const { ctx } = makeCtx({
            settled: true,
            prompt: async () => {
                throw new AgentHarnessError("auth", "no credentials");
            },
        });
        const method = getRegisteredMethod("session.prompt");
        assert.ok(method);

        // Must NOT be laundered into session_busy — a client that retries an
        // auth failure loops forever.
        await assert.rejects(method.handler(ctx), (e: unknown) => {
            return e instanceof AgentHarnessError && e.code === "auth";
        });
    });

    it("proceeds normally once compaction has settled", async () => {
        const { ctx, promptCalls } = makeCtx({
            settled: true,
            prompt: async () => ({ role: "assistant", content: "ok" }),
        });
        const method = getRegisteredMethod("session.prompt");
        assert.ok(method);

        await method.handler(ctx);
        assert.equal(promptCalls(), 1);
    });
});

describe("session.submitAnswers busy paths", () => {
    it("returns session_busy without prompting when compaction never settles", async () => {
        const { ctx, promptCalls } = makeCtx({
            settled: false,
            prompt: async () => undefined,
            params: { toolCallId: "tc-1", answers: { q: "a" } },
        });
        const method = getRegisteredMethod("session.submitAnswers");
        assert.ok(method);

        await assert.rejects(method.handler(ctx), isSessionBusy);
        assert.equal(promptCalls(), 0);
    });
});
