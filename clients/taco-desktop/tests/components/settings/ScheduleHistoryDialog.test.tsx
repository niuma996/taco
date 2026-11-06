import { describe, expect, it } from "vitest";
import { formatDreamFailureReason } from "../../../src/components/settings/ScheduleHistoryDialog";

describe("memory consolidation history reasons", () => {
    it("maps common scheduler failures to readable causes", () => {
        expect(formatDreamFailureReason("fire timeout after 5m", (key) => key)).toContain(
            "fireTimeout",
        );
        expect(
            formatDreamFailureReason("the model call timed out after 4 minutes", (key) => key),
        ).toContain("modelTimeout");
        expect(
            formatDreamFailureReason(
                "rejected plan: merge source abc does not exist",
                (key) => key,
            ),
        ).toContain("invalidReference");
        expect(
            formatDreamFailureReason("the model returned no parseable plan", (key) => key),
        ).toContain("invalidOutput");
    });
});
