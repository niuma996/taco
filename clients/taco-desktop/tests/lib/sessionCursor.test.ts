import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SessionCursor } from "../../src/lib/sessionCursor.ts";

describe("SessionCursor", () => {
    it("accepts only the next sequence and drops a duplicate", () => {
        const cursor = new SessionCursor();
        assert.equal(cursor.observe("/workspace", "session", 1), "accepted");
        assert.equal(cursor.observe("/workspace", "session", 1), "duplicate");
        assert.equal(cursor.last("/workspace", "session"), 1);
    });

    it("reports the last cursor when a frame skips a sequence", () => {
        const cursor = new SessionCursor();
        cursor.observe("/workspace", "session", 1);

        assert.deepEqual(cursor.observe("/workspace", "session", 3), {
            kind: "gap",
            afterSeq: 1,
        });
        assert.equal(cursor.last("/workspace", "session"), 1);
    });
});
