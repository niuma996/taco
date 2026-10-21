/**
 * The config approval path.
 *
 * A config change asks the user, always — it can widen what later commands
 * are allowed to do, so no rule set auto-approves it. The scope is "once"
 * only: a stored rule would let a later turn widen its own permissions
 * without asking again.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { CommandPermissionRequest } from "@taco-ai/protocol";
import { PermissionBroker } from "../../src/permissions/permissionBroker.ts";

const noRules = { mode: "ask" } as const;

describe("PermissionBroker config approval", () => {
    it("asks, and reports the fields being changed", async () => {
        const broker = new PermissionBroker(() => noRules);
        const requested: CommandPermissionRequest[] = [];
        broker.on("requested", (r: CommandPermissionRequest) => requested.push(r));

        const pending = broker.requestConfigApproval({
            sessionId: "s1",
            toolCallId: "tc1",
            fields: ["defaultModel", "thinkingLevel"],
        });
        await Promise.resolve();

        assert.equal(requested.length, 1);
        assert.equal(requested[0].kind, "config");
        assert.deepEqual(requested[0].configFields, ["defaultModel", "thinkingLevel"]);
        // The command slot carries a readable stand-in — there is no command.
        assert.match(requested[0].command, /defaultModel/);

        broker.resolve(requested[0].requestId, true, "once");
        const decision = await pending;
        assert.equal(decision.approved, true);
    });

    it("is never persistable: a session or global scope falls back to once", async () => {
        const broker = new PermissionBroker(() => noRules);
        const requested: CommandPermissionRequest[] = [];
        broker.on("requested", (r: CommandPermissionRequest) => requested.push(r));

        const pending = broker.requestConfigApproval({
            sessionId: "s1",
            toolCallId: "tc1",
            fields: ["defaultModel"],
        });
        await Promise.resolve();

        broker.resolve(requested[0].requestId, true, "global");
        const decision = await pending;
        assert.equal(decision.scope, "once");
    });

    it("denies at once when no approver can answer", async () => {
        const broker = new PermissionBroker(() => noRules, { hasApprover: () => false });
        const decision = await broker.requestConfigApproval({
            sessionId: "s1",
            toolCallId: "tc1",
            fields: ["defaultModel"],
        });
        assert.equal(decision.approved, false);
        assert.equal(decision.denialReason, "no_approver");
    });

    it("a declined change writes nothing", async () => {
        const broker = new PermissionBroker(() => noRules);
        const requested: CommandPermissionRequest[] = [];
        broker.on("requested", (r: CommandPermissionRequest) => requested.push(r));

        const pending = broker.requestConfigApproval({
            sessionId: "s1",
            toolCallId: "tc1",
            fields: ["commandPermissions"],
        });
        await Promise.resolve();
        broker.resolve(requested[0].requestId, false, "once");

        const decision = await pending;
        assert.equal(decision.approved, false);
        assert.equal(decision.denialReason, "user_denied");
    });
});
