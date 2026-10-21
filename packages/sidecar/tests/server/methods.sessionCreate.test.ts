/**
 * Handler-level unit tests for session.create rollback (an `initialPrompt`
 * failure removes only a transcript with no persisted message) and setModel /
 * setThinkingLevel error normalization.
 *
 * Uses a stub workspace to simulate attach/prompt/detach success/failure paths
 * without running a real harness — handler touches only detach / attach /
 * repo.delete / invalidateListCache / getAttached.
 */

import { strict as assert } from "node:assert";
import { before, describe, it } from "node:test";
import type { SessionId, WorkspaceId } from "@taco-ai/protocol";
import { asWorkspaceId } from "@taco-ai/protocol";
import type { JsonlSessionMetadata } from "../../src/runtime/pi/types.ts";

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
        create(opts: { id: SessionId; cwd: WorkspaceId }): Promise<{
            metadata: JsonlSessionMetadata;
            close(): Promise<void>;
        }>;
        delete(meta: JsonlSessionMetadata): Promise<void>;
    };
    invalidateListCache(): void;
    setSessionModel(id: SessionId, provider: string, modelId: string): Promise<void>;
    setSessionThinkingLevel(id: SessionId, level: string): Promise<void>;
    setPlaceholderTitle(id: SessionId, name: string): Promise<boolean>;
    /** Last persisted message time; `undefined` models a transcript with no messages. */
    getSessionActivityAt(id: SessionId): Promise<number | undefined>;
    /** Stub already resolved its default model. */
    defaultModel?: unknown;
}

function makeStub(): WorkspaceStub {
    const calls: string[] = [];
    const attached = new Map<SessionId, AttachedLike>();
    const meta: JsonlSessionMetadata = {
        id: "sess-1",
        createdAt: Date.UTC(2026, 0, 1),
        modifiedAt: Date.UTC(2026, 0, 1),
        storageVersion: 1,
        cwd: "/tmp/test-ws",
        path: "/tmp/test-ws/.pi/agent/sessions/sess-1.jsonl",
    };
    return {
        cwd: asWorkspaceId("/tmp/test-ws"),
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
                // pi 0.85 returns an *open* session with metadata as a plain
                // property. The handler must close it before attaching, so the
                // stub records that call — a missed close is what makes the
                // real repo reject the subsequent open.
                return {
                    metadata: meta,
                    close: async () => {
                        calls.push(`session.close(${opts.id})`);
                    },
                };
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
        async setPlaceholderTitle(id, name) {
            calls.push(`setPlaceholderTitle(${id},${name})`);
            return true;
        },
        async getSessionActivityAt(id) {
            calls.push(`getSessionActivityAt(${id})`);
            const flags = attached as unknown as {
                _activityAt?: number;
                _failActivityProbe?: boolean;
            };
            if (flags._failActivityProbe) throw new Error("probe-boom");
            return flags._activityAt;
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

type StubFlags = {
    _failAttach?: boolean;
    _failPrompt?: boolean;
    _activityAt?: number;
    _failActivityProbe?: boolean;
};

function flagsOf(stub: WorkspaceStub): StubFlags {
    return stub.attached as unknown as StubFlags;
}

async function createWithInitialPrompt(stub: WorkspaceStub, expectedMessage: string) {
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
        (e: unknown) => e instanceof Error && e.message === expectedMessage,
    );
    return stub.calls.slice(before);
}

describe("session.create rollback", () => {
    it("removes the transcript when the turn failed before any message was persisted", async () => {
        const stub = makeStub();
        flagsOf(stub)._failAttach = true;
        const tail = await createWithInitialPrompt(stub, "attach-throw");
        assert.ok(tail.includes("detach(sess-1)"), "detach should be called (idempotent)");
        assert.ok(tail.includes("repo.delete(sess-1)"), "empty orphan jsonl should be deleted");
        // The probe must read disk, not a cache that predates the failed turn.
        const iDetach = tail.indexOf("detach(sess-1)");
        // The handler also invalidates once right after repo.create; only the
        // call that follows the detach is the rollback's.
        const iFirstInv = tail.indexOf("invalidateListCache", iDetach);
        const iProbe = tail.indexOf("getSessionActivityAt(sess-1)");
        const iDelete = tail.indexOf("repo.delete(sess-1)");
        assert.ok(iDetach >= 0 && iFirstInv > iDetach && iProbe > iFirstInv, "probe order wrong");
        assert.ok(iDelete > iProbe, "repo.delete must come after the emptiness probe");
        assert.ok(tail.lastIndexOf("invalidateListCache") > iDelete, "cache dropped after delete");
    });

    it("keeps the transcript when the prompt failed after messages were persisted", async () => {
        const stub = makeStub();
        flagsOf(stub)._failPrompt = true;
        flagsOf(stub)._activityAt = Date.UTC(2026, 0, 1, 0, 5);
        const tail = await createWithInitialPrompt(stub, "boom");
        assert.ok(tail.indexOf("attach(sess-1)") < tail.indexOf("prompt(hello)"));
        assert.ok(tail.includes("detach(sess-1)"), "the failed run's handle is still released");
        assert.ok(
            !tail.includes("repo.delete(sess-1)"),
            `a conversation with persisted messages must survive, got: ${tail.join(", ")}`,
        );
    });

    it("keeps the transcript when the emptiness probe itself fails", async () => {
        const stub = makeStub();
        flagsOf(stub)._failPrompt = true;
        flagsOf(stub)._failActivityProbe = true;
        const tail = await createWithInitialPrompt(stub, "boom");
        assert.ok(
            !tail.includes("repo.delete(sess-1)"),
            "an unreadable transcript cannot be proven empty, so it is not deleted",
        );
    });

    it("never announces a deletion on failure (no session.deleted source)", async () => {
        const stub = makeStub();
        flagsOf(stub)._failPrompt = true;
        flagsOf(stub)._activityAt = Date.UTC(2026, 0, 1, 0, 5);
        const tail = await createWithInitialPrompt(stub, "boom");
        assert.ok(!tail.some((c) => c.includes("deleteSession")));
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
