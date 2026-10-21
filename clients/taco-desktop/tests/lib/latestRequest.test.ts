import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLatestRequestGuard } from "../../src/lib/latestRequest.ts";

describe("createLatestRequestGuard", () => {
    it("invalidates an older request when a newer request begins", () => {
        const guard = createLatestRequestGuard();
        const firstIsCurrent = guard.begin();
        const secondIsCurrent = guard.begin();

        assert.equal(firstIsCurrent(), false);
        assert.equal(secondIsCurrent(), true);
    });

    it("invalidates an in-flight request when the caller cancels it", () => {
        const guard = createLatestRequestGuard();
        const isCurrent = guard.begin();

        guard.invalidate();

        assert.equal(isCurrent(), false);
    });
});
