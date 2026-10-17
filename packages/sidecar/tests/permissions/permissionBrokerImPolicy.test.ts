import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { CommandPermissionConfig } from "@taco-ai/protocol";
import { PermissionBroker } from "../../src/permissions/permissionBroker.ts";

const GLOBAL: CommandPermissionConfig = { mode: "ask", allow: [], deny: [] };

describe("PermissionBroker IM policy", () => {
    it("without an IM policy, behaviour is byte-identical to today", async () => {
        const broker = new PermissionBroker(() => GLOBAL, { requestTimeoutMs: 50 });
        let requested = 0;
        broker.on("requested", () => requested++);
        const decision = await broker.evaluateAndRequest({
            sessionId: "s1",
            toolCallId: "t1",
            command: "ls",
        });
        assert.equal(decision.approved, false);
        assert.equal(requested, 1); // ask path still opens a request
    });

    it("auto channel approves a non-denylisted command without emitting a request", async () => {
        const broker = new PermissionBroker(() => GLOBAL, {
            imCommandPolicy: () => ({ mode: "auto" }),
        });
        let requested = 0;
        broker.on("requested", () => requested++);
        const decision = await broker.evaluateAndRequest({
            sessionId: "s1",
            toolCallId: "t1",
            command: "pnpm build",
        });
        assert.equal(decision.approved, true);
        assert.equal(requested, 0);
    });

    it("auto channel still asks for a channel-denylisted command", async () => {
        const broker = new PermissionBroker(() => GLOBAL, {
            imCommandPolicy: () => ({ mode: "auto", deny: ["cat *"] }),
            requestTimeoutMs: 50,
        });
        let requested = 0;
        broker.on("requested", () => requested++);
        const decision = await broker.evaluateAndRequest({
            sessionId: "s1",
            toolCallId: "t1",
            command: "cat f",
        });
        assert.equal(decision.approved, false);
        assert.equal(requested, 1);
        assert.equal(decision.evaluation.matchedList, "deny");
    });

    it("session-scoped approvals still apply on the ask path", async () => {
        const broker = new PermissionBroker(() => GLOBAL);
        const requestId = new Promise<string>((resolve) => {
            broker.once("requested", (value) => resolve(value.requestId));
        });
        const pending = broker.evaluateAndRequest({
            sessionId: "s1",
            toolCallId: "t1",
            command: "pnpm test",
        });
        broker.resolve(await requestId, true, "session");
        assert.equal((await pending).approved, true);

        const next = await broker.evaluateAndRequest({
            sessionId: "s1",
            toolCallId: "t2",
            command: "pnpm test",
        });
        assert.equal(next.approved, true);
    });
});
