/**
 * Ingress busy→followUp fallback tests.
 *
 * DefaultChannelContext.submit dispatches session.prompt; when the server
 * rejects with session_busy (a run is already in flight for the conversation),
 * the message must be enqueued as a follow-up — consumed once the current run
 * would finish, rather than redirecting it mid-flight the way steer would. If
 * the follow-up reports mode "idle" (the run ended in between), the prompt is
 * retried exactly once.
 *
 * Run: pnpm --filter @taco-ai/sidecar test tests/channels/ingress.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RpcRequest, RpcResponse } from "@taco-ai/protocol";
import type { ConversationRouter } from "../../src/channels/conversationRouter.ts";
import { DefaultChannelContext } from "../../src/channels/ingress.ts";
import type { ChannelConfigStore, Logger } from "../../src/channels/types.ts";
import type { ServerRpcSurface } from "../../src/runtime/serverRpcSurface.ts";

const WORKSPACE = "im://mock-1/u1/c1";
const SESSION_ID = "sess-1";

interface RecordedCall {
    method: string;
    commandId: string | undefined;
}

function makeLogger(warnings: string[]): Logger {
    const log: Logger = {
        debug: () => {},
        info: () => {},
        warn: (msg) => {
            warnings.push(msg);
        },
        error: () => {},
        child: () => log,
    };
    return log;
}

function makeCtx(
    respond: (req: RpcRequest, calls: RecordedCall[]) => RpcResponse,
    warnings: string[],
): { ctx: DefaultChannelContext; calls: RecordedCall[] } {
    const calls: RecordedCall[] = [];
    const hook = {
        dispatchRpc: async (req: RpcRequest): Promise<RpcResponse> => {
            calls.push({ method: req.method, commandId: req.commandId });
            return respond(req, calls);
        },
    } as unknown as ServerRpcSurface;
    const router = {
        route: async () => ({ workspace: WORKSPACE, sessionId: SESSION_ID }),
    } as unknown as ConversationRouter;
    const store: ChannelConfigStore = {
        get: () => undefined,
        set: async () => {},
        clear: async () => {},
    };
    const ctx = new DefaultChannelContext("mock-1", hook, router, store, makeLogger(warnings));
    return { ctx, calls };
}

function submit(ctx: DefaultChannelContext, platformMessageId = "msg-1") {
    return ctx.ingress.submit({
        channelId: "mock-1",
        peerId: "u1",
        chatId: "c1",
        platformMessageId,
        text: "hello",
    });
}

const ok = (id: string, result: unknown = {}): RpcResponse => ({ id, ok: true, result });
const err = (id: string, code: string): RpcResponse => ({
    id,
    ok: false,
    error: { code, message: code },
});

describe("ingress busy→followUp fallback", () => {
    it("prompt ok → no followUp, no warnings", async () => {
        const warnings: string[] = [];
        const { ctx, calls } = makeCtx((req) => ok(req.id), warnings);
        await submit(ctx);
        assert.deepEqual(
            calls.map((c) => c.method),
            ["session.prompt"],
        );
        assert.deepEqual(warnings, []);
    });

    it("prompt session_busy → followUp enqueues (mode queued), no retry", async () => {
        const warnings: string[] = [];
        const { ctx, calls } = makeCtx((req) => {
            if (req.method === "session.prompt") return err(req.id, "session_busy");
            return ok(req.id, { mode: "queued" });
        }, warnings);
        const res = await submit(ctx);
        assert.equal(res.sessionId, SESSION_ID);
        assert.deepEqual(
            calls.map((c) => c.method),
            ["session.prompt", "session.followUp"],
        );
        // The follow-up gets its own commandId so dedup cannot replay the
        // prompt's cached busy outcome.
        assert.equal(calls[1]?.commandId, "msg-1:followUp");
        assert.deepEqual(warnings, []);
    });

    it("prompt busy → followUp idle (run ended) → prompt retried once with a fresh commandId", async () => {
        const warnings: string[] = [];
        const { ctx, calls } = makeCtx((req, prev) => {
            if (req.method === "session.followUp") return ok(req.id, { mode: "idle" });
            // First prompt is busy; the retry succeeds.
            if (req.method === "session.prompt" && prev.length === 1) {
                return err(req.id, "session_busy");
            }
            return ok(req.id);
        }, warnings);
        await submit(ctx);
        assert.deepEqual(
            calls.map((c) => c.method),
            ["session.prompt", "session.followUp", "session.prompt"],
        );
        assert.equal(calls[2]?.commandId, "msg-1:retry");
        assert.deepEqual(warnings, []);
    });

    it("followUp fallback rejected → warn logged, no retry", async () => {
        const warnings: string[] = [];
        const { ctx, calls } = makeCtx((req) => {
            if (req.method === "session.prompt") return err(req.id, "session_busy");
            return err(req.id, "internal");
        }, warnings);
        await submit(ctx);
        assert.deepEqual(
            calls.map((c) => c.method),
            ["session.prompt", "session.followUp"],
        );
        assert.equal(warnings.length, 1);
        assert.match(warnings[0] ?? "", /followUp fallback rejected/);
    });

    it("prompt failure other than busy → warn logged, no followUp", async () => {
        const warnings: string[] = [];
        const { ctx, calls } = makeCtx((req) => err(req.id, "internal"), warnings);
        await submit(ctx);
        assert.deepEqual(
            calls.map((c) => c.method),
            ["session.prompt"],
        );
        assert.equal(warnings.length, 1);
        assert.match(warnings[0] ?? "", /prompt rejected/);
    });
});
