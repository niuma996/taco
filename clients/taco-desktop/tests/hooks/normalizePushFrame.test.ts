/**
 * `normalizePushFrame`'s `subagent.settled` mapping — the outcome union grew
 * an `"aborted"` value (a deliberate stop, not a failure) while a two-way
 * `outcome === "error" ? "error" : "completed"` ternary silently folded it
 * into `"completed"`. That bug reached production with 0 test coverage on
 * this exact mapping; this file exists so it cannot regress silently again.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { asSessionId, asWorkspaceId, PushMethods, type ServerPush } from "@taco-ai/protocol";
import { normalizePushFrame, type SidecarAction } from "../../src/hooks/useSidecarStream.ts";

function settledFrame(outcome: unknown): ServerPush {
    return {
        method: PushMethods.SubagentSettled,
        workspace: asWorkspaceId("/workspace"),
        session: asSessionId("parent-session"),
        params: {
            parentSessionId: "parent-session",
            parentToolCallId: "tc-1",
            subSessionId: "child-session",
            agentType: "explorer",
            outcome,
        },
    };
}

describe("normalizePushFrame — subagent.settled", () => {
    for (const outcome of ["completed", "error", "aborted"] as const) {
        it(`passes "${outcome}" through unchanged`, () => {
            let dispatched: SidecarAction | undefined;
            normalizePushFrame(settledFrame(outcome), (a) => {
                dispatched = a;
            });
            assert.equal(dispatched?.type, "SUBAGENT_SETTLED");
            assert.equal(
                (dispatched as { outcome?: string } | undefined)?.outcome,
                outcome,
                `"${outcome}" must not be folded into a different outcome`,
            );
        });
    }

    it("falls back to completed for an unrecognized outcome value", () => {
        let dispatched: SidecarAction | undefined;
        normalizePushFrame(settledFrame("something-new"), (a) => {
            dispatched = a;
        });
        assert.equal((dispatched as { outcome?: string } | undefined)?.outcome, "completed");
    });
});
