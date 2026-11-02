import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
    RPC,
    WORK_RESULT_TEXT_LIMIT,
    type WorkGetResult,
    type WorkListResult,
    type WorkRetryDeliveryResult,
} from "@taco-ai/protocol";
import { RpcHandlerError } from "../../../src/server/methodRegistry.ts";
import { registerBuiltinMethods } from "../../../src/server/methods.ts";
import type { WorkController } from "../../../src/work/workController.ts";
import { type DeliveryClock, systemClock } from "../../../src/work/workDelivery.ts";
import { WorkService } from "../../../src/work/workService.ts";
import { callMethod } from "../../_helpers/handlerCall.ts";

describe("work.* handlers", () => {
    let root: string;
    let seq = 0;

    before(() => {
        registerBuiltinMethods();
        root = mkdtempSync(join(tmpdir(), "taco-work-rpc-"));
    });
    after(() => rmSync(root, { recursive: true, force: true }));

    const clock: DeliveryClock = {
        now: () => Date.now(),
        random: () => 0.5,
        setTimer: (fn, ms) => systemClock.setTimer(fn, ms),
    };

    function rig() {
        const service = new WorkService({
            root: join(root, `s${seq++}`),
            instanceId: "inst-rpc",
            channels: {
                sendText: async () => ({ kind: "confirmed" as const }),
                maxMessageLength: () => 2000,
            },
            resolveRoute: () => undefined,
            clock,
        });
        const controller: WorkController = service.controller;
        const server = { work: service };
        return { service, controller, server };
    }

    async function launchAndSettle(
        controller: WorkController,
        n: number,
        text: string,
        outcome: "completed" | "error" | "aborted" = "completed",
    ) {
        const work = await controller.start({
            sourceEventId: `subagent:p:${n}`,
            workspace: "/w",
            parentSessionId: "p",
            childSessionId: `c${n}`,
            agentType: "explorer",
            title: `job ${n}`,
        });
        await controller.settle({
            workId: work.workId,
            outcome,
            resultText: text,
            parentWillReply: false,
        });
        return work.workId;
    }

    it("registers the three methods under their wire names", () => {
        assert.equal(RPC.workList, "work.list");
        assert.equal(RPC.workGet, "work.get");
        assert.equal(RPC.workRetryDelivery, "work.retryDelivery");
    });

    describe("work.list", () => {
        it("lists Works that no session has attached", async () => {
            const { controller, server } = rig();
            const id = await launchAndSettle(controller, 1, "answer");
            const result = await callMethod<WorkListResult>("work.list", { server, params: {} });
            assert.equal(result.instanceId, "inst-rpc");
            assert.deepEqual(
                result.terminal.map((w) => w.workId),
                [id],
            );
        });

        it("answers with an empty overview when the Work layer is absent", async () => {
            const result = await callMethod<WorkListResult>("work.list", {
                server: {},
                params: {},
            });
            assert.deepEqual(result.active, []);
            assert.deepEqual(result.terminal, []);
        });

        it("rejects a limit outside the allowed range before the handler runs", async () => {
            const { server } = rig();
            for (const limit of [0, 10_000, 1.5]) {
                await assert.rejects(
                    () => callMethod("work.list", { server, params: { limit } }),
                    (e: unknown) => e instanceof RpcHandlerError && e.code === "invalid_params",
                    String(limit),
                );
            }
        });
    });

    describe("work.get", () => {
        it("returns the stored answer, not just the summary line", async () => {
            const { controller, server } = rig();
            const text = `${"x".repeat(1000)} the tail`;
            const id = await launchAndSettle(controller, 2, text);
            const got = await callMethod<WorkGetResult>("work.get", {
                server,
                params: { workId: id },
            });
            assert.equal(got.work?.workId, id);
            assert.equal(got.resultText, text);
            assert.equal(got.resultTruncated, undefined);
        });

        it("caps a very long answer and says so", async () => {
            const { controller, server } = rig();
            const id = await launchAndSettle(
                controller,
                3,
                "y".repeat(WORK_RESULT_TEXT_LIMIT + 500),
            );
            const got = await callMethod<WorkGetResult>("work.get", {
                server,
                params: { workId: id },
            });
            assert.equal(got.resultText?.length, WORK_RESULT_TEXT_LIMIT);
            assert.equal(got.resultTruncated, true);
        });

        it("returns no work for an unknown id", async () => {
            const { server } = rig();
            const got = await callMethod<WorkGetResult>("work.get", {
                server,
                params: { workId: "w-nope" },
            });
            assert.deepEqual(got, { work: null });
        });

        it("rejects an id that could name a path, at the schema", async () => {
            const { server } = rig();
            for (const workId of ["../etc", "a/b", "", ".hidden", "a\\b"]) {
                await assert.rejects(
                    () => callMethod("work.get", { server, params: { workId } }),
                    (e: unknown) => e instanceof RpcHandlerError && e.code === "invalid_params",
                    workId,
                );
            }
        });

        it("answers the summary alone when the stored result no longer verifies", async () => {
            const { controller, service, server } = rig();
            const id = await launchAndSettle(controller, 4, "real answer");
            await service.store.mutate(id, (w) =>
                w.result ? { ...w, result: { ...w.result, checksum: "tampered" } } : undefined,
            );
            const got = await callMethod<WorkGetResult>("work.get", {
                server,
                params: { workId: id },
            });
            assert.equal(got.work?.workId, id);
            assert.equal(got.resultText, undefined);
        });
    });

    describe("work.retryDelivery", () => {
        it("re-sends a notice that gave up and reports it accepted", async () => {
            const { controller, service, server } = rig();
            const id = await launchAndSettle(controller, 5, "answer");
            await service.store.mutate(id, (w) => ({
                ...w,
                delivery: {
                    deliveryId: "d",
                    target: { channelId: "c1", peerId: "p", chatId: "p" },
                    status: "retryExhausted",
                    chunks: ["hello"],
                    source: "template",
                    maxMessageLength: 100,
                    confirmedChunks: 0,
                    attempts: 10,
                    createdAt: Date.now(),
                },
            }));
            const result = await callMethod<WorkRetryDeliveryResult>("work.retryDelivery", {
                server,
                params: { workId: id },
            });
            assert.equal(result.outcome, "accepted");
        });

        it("refuses a delivery that is not stuck", async () => {
            const { controller, server } = rig();
            const id = await launchAndSettle(controller, 6, "answer");
            const result = await callMethod<WorkRetryDeliveryResult>("work.retryDelivery", {
                server,
                params: { workId: id },
            });
            assert.notEqual(result.outcome, "accepted");
        });

        it("reports not_found for an unknown Work", async () => {
            const { server } = rig();
            const result = await callMethod<WorkRetryDeliveryResult>("work.retryDelivery", {
                server,
                params: { workId: "w-nope" },
            });
            assert.equal(result.outcome, "not_found");
        });
    });
});
