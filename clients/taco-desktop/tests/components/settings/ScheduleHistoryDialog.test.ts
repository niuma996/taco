import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatDreamFailureReason } from "../../../src/components/settings/ScheduleHistoryDialog";

describe("memory consolidation history reasons", () => {
    it("maps common scheduler failures to readable causes", () => {
        assert.ok(
            formatDreamFailureReason("fire timeout after 5m", (key) => key).includes("fireTimeout"),
        );
        assert.ok(
            formatDreamFailureReason(
                "the model call timed out after 4 minutes",
                (key) => key,
            ).includes("modelTimeout"),
        );
        assert.ok(
            formatDreamFailureReason(
                "rejected plan: merge source abc does not exist",
                (key) => key,
            ).includes("invalidReference"),
        );
        assert.ok(
            formatDreamFailureReason("the model returned no parseable plan", (key) => key).includes(
                "invalidOutput",
            ),
        );
    });
});

it("keeps waiting Work visible as waiting in scheduled history", async () => {
    const { runState } = await import("../../../src/components/settings/ScheduleHistoryDialog");
    assert.equal(runState({ status: "ok" } as never, { status: "waiting" } as never), "waiting");
});
