/**
 * Handler-level unit tests for session.create rollback and setModel /
 * setThinkingLevel error normalization.
 *
 * Uses a stub workspace to simulate attach/prompt/detach success/failure paths
 * without running a real harness — handler touches only detach / attach /
 * repo.delete / invalidateListCache / getAttached.
 */

import { strict as assert } from "node:assert";
import { before, describe, it } from "node:test";

import type { JsonlSessionMetadata } from "@earendil-works/pi-agent-core";
import type { SessionId, WorkspaceId } from "@taco-ai/protocol";

import {
    getRegisteredMethod,
    type MethodCtx,
    RpcHandlerError,
} from "../../src/server/methodRegistry.ts";
import { registerBuiltinMethods } from "../../src/server/methods.ts";

interface AttachedLike {
    prompt(text: string, images?: unknown): Promise<{ role: string; text: string }>;
}

interface WorkspaceStub {
    cwd: WorkspaceId;
    calls: string[];
    attached: Map<SessionId, AttachedLike>;
    meta: JsonlSessionMetadata;
    getAttached(id: SessionId): AttachedLike | undefined;
    attach(id: SessionId): Promise<AttachedLike>;
    detach(id: SessionId): Promise<void>;
    repo: {
        create(opts: { id: SessionId; cwd: WorkspaceId }): Promise<unknown>;
        delete(meta: JsonlSessionMetadata): Promise<void>;
    };
    invalidateListCache(): void;
    setSessionModel(id: SessionId, provider: string, modelId: string): Promise<void>;
    setSessionThinkingLevel(id: SessionId, level: string): Promise<void>;
    /** Stub already resolved its default model. */
    defaultModel?: unknown;
}

function makeStub(): WorkspaceStub {
    const calls: string[] = [];
    const attached = new Map<SessionId, AttachedLike>();
    const meta: JsonlSessionMetadata = {
        id: "sess-1",
        createdAt: "2026-01-01T00:00:00Z",
        cwd: "/tmp/test-ws",
        path: "/tmp/test-ws/.pi/agent/sessions/sess-1.jsonl",
    };
    return {
        cwd: "/tmp/test-ws",
        calls,
        attached,
        meta,
        getAttached(id) {
            calls.push(`getAttached(${id})`);
            return attached.get(id);
        },
        async attach(id) {
            calls.push(`attach(${id})`);
            // Injected failure: stubAttached.fail = true / false
            const flags = attached as unknown as {
                _failAttach?: boolean;
                _failPrompt?: boolean;
            };
            const stubAttached: AttachedLike = flags._failAttach
                ? {
                      async prompt() {
                          throw new Error("attach-throw");
                      },
                  }
                : {
                      async prompt(text: string) {
                          calls.push(`prompt(${text})`);
                          // Distinguish prompt-success / prompt-failure
                          if (flags._failPrompt) {
                              throw new Error("boom");
                          }
                          return { role: "assistant", text: `reply to ${text}` };
                      },
                  };
            attached.set(id, stubAttached);
            return stubAttached;
        },
        async detach(id) {
            calls.push(`detach(${id})`);
            attached.delete(id);
        },
        repo: {
            async create(opts) {
                calls.push(`repo.create(${opts.id})`);
                return { getMetadata: async () => meta };
            },
            async delete(m) {
                calls.push(`repo.delete(${m.id})`);
            },
        },
        invalidateListCache() {
            calls.push("invalidateListCache");
        },
        async setSessionModel(id, provider, modelId) {
            calls.push(`setSessionModel(${id},${provider},${modelId})`);
        },
        async setSessionThinkingLevel(id, level) {
            calls.push(`setSessionThinkingLevel(${id},${level})`);
        },
        // Placeholder so session.create's defaultModel guard passes.
        defaultModel: { id: "stub-model" },
    };
}

function makeCtx(stub: WorkspaceStub, _method: string, params: unknown): MethodCtx<unknown> {
    return {
        id: "test-id",
        workspace: stub as unknown as MethodCtx<unknown>["workspace"],
        cwd: stub.cwd,
        // server field not used in the tested handler.
        server: {} as MethodCtx<unknown>["server"],
        params,
    };
}

before(() => {
    registerBuiltinMethods();
});

describe("session.create rollback", () => {
    it("rollback on prompt failure: detach + repo.delete + invalidate, no session.deleted", async () => {
        const stub = makeStub();
        // Make attach succeed, prompt fail
        (stub.attached as unknown as { _failPrompt: boolean })._failPrompt = true;
        const handler = getRegisteredMethod("session.create");
        assert.ok(handler, "session.create should be registered");
        const before = stub.calls.length;
        await assert.rejects(
            () =>
                handler.handler(
                    makeCtx(stub, "session.create", {
                        sessionId: "sess-1",
                        cwd: "/tmp/test-ws",
                        initialPrompt: "hello",
                    }),
                ),
            (e: unknown) => e instanceof Error && e.message === "boom",
        );
        const tail = stub.calls.slice(before);
        // Order: attach -> prompt(fails) -> detach -> repo.delete -> invalidateListCache
        const expectedAfterFail = ["detach(sess-1)", "repo.delete(sess-1)", "invalidateListCache"];
        for (const expected of expectedAfterFail) {
            assert.ok(
                tail.includes(expected),
                `expected call ${expected} in log, got: ${tail.join(", ")}`,
            );
        }
        // Order guarantee: rollback sequence — detach -> repo.delete -> invalidateListCache.
        // Uses lastIndexOf because the handler also calls invalidateListCache once after repo.create
        // (on the success path cache refresh), which must not be confused with the rollback call.
        const iDetach = tail.indexOf("detach(sess-1)");
        const iDelete = tail.indexOf("repo.delete(sess-1)");
        const iInv = tail.lastIndexOf("invalidateListCache");
        assert.ok(iDetach >= 0 && iDelete > iDetach && iInv > iDelete, "rollback order wrong");
        // attach must precede prompt (verifies prompt was actually reached)
        assert.ok(tail.indexOf("attach(sess-1)") < tail.indexOf("detach(sess-1)"));
    });

    it("rollback on attach failure: detach (no-op) + repo.delete + invalidate", async () => {
        const stub = makeStub();
        // Make attach itself throw
        (stub.attached as unknown as { _failAttach: boolean })._failAttach = true;
        const handler = getRegisteredMethod("session.create");
        assert.ok(handler);
        const before = stub.calls.length;
        await assert.rejects(
            () =>
                handler.handler(
                    makeCtx(stub, "session.create", {
                        sessionId: "sess-1",
                        cwd: "/tmp/test-ws",
                        initialPrompt: "hello",
                    }),
                ),
            (e: unknown) => e instanceof Error && e.message === "attach-throw",
        );
        const tail = stub.calls.slice(before);
        // When attach fails, detach is a no-op (attached Map is empty) — still records the call
        assert.ok(tail.includes("detach(sess-1)"), "detach should be called (idempotent)");
        assert.ok(tail.includes("repo.delete(sess-1)"), "orphan jsonl should be deleted");
        assert.ok(tail.includes("invalidateListCache"), "cache should be invalidated");
        // Order: repo.delete must come after detach
        const iDetach = tail.indexOf("detach(sess-1)");
        const iDelete = tail.indexOf("repo.delete(sess-1)");
        assert.ok(iDelete > iDetach, "repo.delete must come after detach");
    });

    it("happy path: no rollback calls, returns assistantMessage", async () => {
        const stub = makeStub();
        const handler = getRegisteredMethod("session.create");
        assert.ok(handler);
        const before = stub.calls.length;
        const result = (await handler.handler(
            makeCtx(stub, "session.create", {
                sessionId: "sess-1",
                cwd: "/tmp/test-ws",
                initialPrompt: "hi",
            }),
        )) as { sessionId: string; filePath: string; assistantMessage: { text: string } };
        const tail = stub.calls.slice(before);
        assert.equal(result.sessionId, "sess-1");
        assert.equal(result.filePath, stub.meta.path);
        assert.deepEqual(result.assistantMessage, { role: "assistant", text: "reply to hi" });
        assert.ok(!tail.includes("detach(sess-1)"), "no detach on success");
        assert.ok(!tail.includes("repo.delete(sess-1)"), "no repo.delete on success");
    });
});

describe("not-attached → invalid_state", () => {
    it("session.setModel throws invalid_state when not attached", async () => {
        const stub = makeStub();
        // getAttached returns undefined by default
        const handler = getRegisteredMethod("session.setModel");
        assert.ok(handler);
        await assert.rejects(
            () =>
                handler.handler(
                    makeCtx(stub, "session.setModel", {
                        sessionId: "sess-1",
                        provider: "minimax",
                        modelId: "MiniMax-M2",
                    }),
                ),
            (e: unknown) =>
                e instanceof RpcHandlerError &&
                e.code === "invalid_state" &&
                /not attached/i.test(e.message),
        );
        // setSessionModel must not be called (only called when attached)
        assert.ok(
            !stub.calls.some((c) => c.startsWith("setSessionModel")),
            "setSessionModel must not be called when not attached",
        );
    });

    it("session.setThinkingLevel throws invalid_state when not attached", async () => {
        const stub = makeStub();
        const handler = getRegisteredMethod("session.setThinkingLevel");
        assert.ok(handler);
        await assert.rejects(
            () =>
                handler.handler(
                    makeCtx(stub, "session.setThinkingLevel", {
                        sessionId: "sess-1",
                        level: "high",
                    }),
                ),
            (e: unknown) =>
                e instanceof RpcHandlerError &&
                e.code === "invalid_state" &&
                /not attached/i.test(e.message),
        );
        assert.ok(
            !stub.calls.some((c) => c.startsWith("setSessionThinkingLevel")),
            "setSessionThinkingLevel must not be called when not attached",
        );
    });
});
