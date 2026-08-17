/**
 * dispatcher.test.ts — verifies the JobCommandInvoker routes
 * `agent.invoke` through the real SidecarServer.dispatchRpc path
 * (single session.create carrying initialPrompt) and surfaces errors
 * as ScheduledCommandFailed so the runner records a meaningful reason.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { RpcRequest, RpcResponse } from "@taco-ai/protocol";
import {
    createJobDispatcher,
    ScheduledCommandFailed,
    UnsupportedScheduledCommand,
} from "../../src/scheduler/dispatcher.ts";

type FakeResponse =
    | { id: string; ok: true; result: unknown }
    | {
          id: string;
          ok: false;
          error: { code: string; message: string };
      };

interface FakeServer {
    calls: RpcRequest[];
    dispatchRpc(req: RpcRequest): Promise<RpcResponse>;
}

function makeFakeServer(respond: (req: RpcRequest) => Promise<FakeResponse>): FakeServer {
    const calls: RpcRequest[] = [];
    return {
        calls,
        dispatchRpc: async (req) => {
            calls.push(req);
            return respond(req) as Promise<RpcResponse>;
        },
    };
}

describe("createJobDispatcher — agent.invoke path", () => {
    it("dispatches a single session.create carrying the prompt", async () => {
        const fake = makeFakeServer(async (req) => {
            assert.equal(req.method, "session.create");
            assert.ok(req.id.startsWith("sched-"), `expected sched- prefix, got ${req.id}`);
            const p = req.params as {
                sessionId?: string;
                initialPrompt?: string;
                workspace?: string;
            };
            assert.equal(p.sessionId, req.id);
            assert.equal(p.initialPrompt, "echo hello");
            assert.equal(p.workspace, "/tmp/w");
            return { id: req.id, ok: true, result: { sessionId: req.id } };
        });
        const dispatcher = createJobDispatcher(fake);
        await dispatcher("agent.invoke", {
            workspace: "/tmp/w",
            prompt: "echo hello",
        });
        assert.equal(fake.calls.length, 1);
    });

    it("uses a fresh sched-<uuid> id each call", async () => {
        const seenIds = new Set<string>();
        const fake = makeFakeServer(async (req) => {
            assert.equal(req.method, "session.create");
            const p = req.params as { sessionId?: string };
            assert.ok(p.sessionId?.startsWith("sched-"), `unexpected id ${p.sessionId}`);
            const sessionId = p.sessionId as string;
            assert.ok(!seenIds.has(sessionId), `duplicate id ${sessionId}`);
            seenIds.add(sessionId);
            return { id: req.id, ok: true, result: { sessionId } };
        });
        const dispatcher = createJobDispatcher(fake);
        await dispatcher("agent.invoke", { workspace: "/tmp/w", prompt: "a" });
        await dispatcher("agent.invoke", { workspace: "/tmp/w", prompt: "b" });
        assert.equal(seenIds.size, 2);
    });

    it("throws ScheduledCommandFailed when dispatchRpc returns !ok", async () => {
        const fake = makeFakeServer(async (req) => ({
            id: req.id,
            ok: false as const,
            error: { code: "not_ready", message: "scheduler not running" },
        }));
        const dispatcher = createJobDispatcher(fake);
        await assert.rejects(
            () => dispatcher("agent.invoke", { workspace: "/tmp/w", prompt: "x" }),
            (err: unknown): err is ScheduledCommandFailed =>
                err instanceof ScheduledCommandFailed &&
                err.code === "not_ready" &&
                err.message === "scheduler not running",
        );
    });

    it("throws UnsupportedScheduledCommand for unknown commands", async () => {
        const fake = makeFakeServer(async () => ({
            id: "x",
            ok: true as const,
            result: null,
        }));
        const dispatcher = createJobDispatcher(fake);
        await assert.rejects(
            () => dispatcher("foo.bar", {}),
            (err: unknown): err is UnsupportedScheduledCommand =>
                err instanceof UnsupportedScheduledCommand &&
                err.message === "unsupported scheduled command: foo.bar",
        );
    });
});
