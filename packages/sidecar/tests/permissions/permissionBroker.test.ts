import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { PermissionBroker } from "../../src/permissions/permissionBroker.ts";

describe("PermissionBroker readOnly mode", () => {
    it("readOnly: isStrictReadOnly command auto-allows", async () => {
        const broker = new PermissionBroker(
            () => ({
                mode: "auto",
                rules: ["rm -rf /"], // would leak without readOnly
            }),
            { readOnly: true },
        );
        const result = await broker.evaluateAndRequest({
            sessionId: "fake-session",
            toolCallId: "fake",
            command: "ls",
        });
        // "ls" is isStrictReadOnly → auto-allow in auto mode
        assert.equal(result.approved, true);
    });

    it("readOnly: mutating command denies immediately (no ask/hang)", async () => {
        const broker = new PermissionBroker(
            () => ({
                mode: "auto",
                rules: ["rm -rf /"], // must be ignored in readOnly
            }),
            { readOnly: true },
        );
        // A user allowlist rule that would normally grant this must NOT apply
        const result = await broker.evaluateAndRequest({
            sessionId: "fake-session",
            toolCallId: "fake",
            command: "rm -rf /",
        });
        assert.equal(result.approved, false);
        assert.equal(result.denialReason, undefined); // immediate deny, not user_denied/timeout
    });

    it("readOnly: user session rules do not leak into evaluation", async () => {
        const broker = new PermissionBroker(() => ({ mode: "auto", rules: [] }), {
            readOnly: true,
        });
        // Inject a session rule that would allow a mutating command — must be ignored
        (broker as unknown as { sessionRules: Map<string, string[]> }).sessionRules.set(
            "fake-session",
            ["touch /tmp/x"],
        );
        const result = await broker.evaluateAndRequest({
            sessionId: "fake-session",
            toolCallId: "fake",
            command: "touch /tmp/x",
        });
        assert.equal(result.approved, false);
    });
});
