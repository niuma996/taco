/**
 * session.compact / session.contextInfo handler tests.
 *
 * Covers two paths:
 *   - "not attached → invalid_state" — workspace.getAttached returns undefined
 *   - "attached → handler directly forwards to AttachedSession.compact / getContextInfo"
 *
 * Uses stub workspace + stub attached to avoid introducing real pi harness / provider
 * heavy dependencies. Integration tests are in attachedSession.compaction.test.ts.
 */

import { strict as assert } from "node:assert";
import { before, describe, it } from "node:test";

import { getRegisteredMethod, RpcHandlerError } from "../../../src/server/methodRegistry.ts";
import { registerBuiltinMethods } from "../../../src/server/methods.ts";

before(() => {
    registerBuiltinMethods();
});

/** Build a MethodCtx whose workspace.getAttached returns undefined, so the
 *  handler must short-circuit with invalid_state before any AttachedSession
 *  method runs. */
function makeNotAttachedCtx(): Parameters<
    NonNullable<ReturnType<typeof getRegisteredMethod>>["handler"]
>[0] {
    const workspace = { getAttached: () => undefined };
    return {
        id: "test-id",
        workspace,
        cwd: "/tmp/ws",
        server: {},
        params: { workspace: "/tmp/ws", sessionId: "sid" },
    } as unknown as Parameters<NonNullable<ReturnType<typeof getRegisteredMethod>>["handler"]>[0];
}

/** Drive a handler that should reject with RpcHandlerError("invalid_state"). */
async function expectInvalidStateNotAttached(method: string): Promise<void> {
    const handler = getRegisteredMethod(method);
    assert.ok(handler, `${method} handler must be registered`);
    await assert.rejects(handler.handler(makeNotAttachedCtx()), (e: unknown) => {
        return (
            e instanceof RpcHandlerError &&
            e.code === "invalid_state" &&
            /not attached/i.test(e.message)
        );
    });
}

describe("session.compact handler", () => {
    it("returns invalid_state when session is not attached", async () => {
        await expectInvalidStateNotAttached("session.compact");
    });

    it("forwards to AttachedSession.compact when attached", async () => {
        let capturedInstructions: string | undefined;
        let calledCount = 0;
        const attached = {
            async compact(customInstructions?: string) {
                calledCount++;
                capturedInstructions = customInstructions;
                return { ok: true, tokensBefore: 12345, fromHook: true };
            },
        };
        const workspace = {
            getAttached() {
                return attached;
            },
        };
        const ctx = {
            id: "test-id",
            workspace,
            cwd: "/tmp/ws",
            server: {},
            params: {
                workspace: "/tmp/ws",
                sessionId: "sid",
                customInstructions: "be terse",
            },
        } as unknown as Parameters<
            NonNullable<ReturnType<typeof getRegisteredMethod>>["handler"]
        >[0];
        const handler = getRegisteredMethod("session.compact");
        assert.ok(handler);
        const out = (await handler.handler(ctx)) as {
            ok: boolean;
            tokensBefore?: number;
            fromHook?: boolean;
        };
        assert.equal(out.ok, true);
        assert.equal(out.tokensBefore, 12345);
        assert.equal(out.fromHook, true);
        assert.equal(calledCount, 1);
        assert.equal(capturedInstructions, "be terse");
    });

    it("omits customInstructions in forwarded params when not provided", async () => {
        const attached = {
            async compact(customInstructions?: string) {
                assert.equal(customInstructions, undefined);
                return { ok: true };
            },
        };
        const workspace = {
            getAttached() {
                return attached;
            },
        };
        const ctx = {
            id: "test-id",
            workspace,
            cwd: "/tmp/ws",
            server: {},
            params: { workspace: "/tmp/ws", sessionId: "sid" },
        } as unknown as Parameters<
            NonNullable<ReturnType<typeof getRegisteredMethod>>["handler"]
        >[0];
        const handler = getRegisteredMethod("session.compact");
        assert.ok(handler);
        await handler.handler(ctx);
    });
});

describe("session.contextInfo handler", () => {
    it("returns invalid_state when session is not attached", async () => {
        await expectInvalidStateNotAttached("session.contextInfo");
    });

    it("forwards to AttachedSession.getContextInfo and returns its shape", async () => {
        const sample = {
            modelId: "claude-sonnet",
            provider: "anthropic",
            contextWindow: 200000,
            usedTokens: 50000,
            ratio: 0.25,
            lastCompactionAt: "2026-07-25T00:00:00.000Z",
        };
        const attached = {
            async getContextInfo() {
                return sample;
            },
        };
        const workspace = {
            getAttached() {
                return attached;
            },
        };
        const ctx = {
            id: "test-id",
            workspace,
            cwd: "/tmp/ws",
            server: {},
            params: { workspace: "/tmp/ws", sessionId: "sid" },
        } as unknown as Parameters<
            NonNullable<ReturnType<typeof getRegisteredMethod>>["handler"]
        >[0];
        const handler = getRegisteredMethod("session.contextInfo");
        assert.ok(handler);
        const out = await handler.handler(ctx);
        assert.deepEqual(out, sample);
    });

    it("omits lastCompactionAt when session has no prior compactions", async () => {
        const attached = {
            async getContextInfo() {
                return {
                    modelId: "m",
                    provider: "p",
                    contextWindow: 100,
                    usedTokens: 10,
                    ratio: 0.1,
                };
            },
        };
        const workspace = {
            getAttached() {
                return attached;
            },
        };
        const ctx = {
            id: "test-id",
            workspace,
            cwd: "/tmp/ws",
            server: {},
            params: { workspace: "/tmp/ws", sessionId: "sid" },
        } as unknown as Parameters<
            NonNullable<ReturnType<typeof getRegisteredMethod>>["handler"]
        >[0];
        const handler = getRegisteredMethod("session.contextInfo");
        assert.ok(handler);
        const out = (await handler.handler(ctx)) as {
            lastCompactionAt?: string;
        };
        assert.equal(out.lastCompactionAt, undefined);
    });
});
