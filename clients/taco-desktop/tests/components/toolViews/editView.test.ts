/**
 * editView's parseUnifiedPatch — the edit card's only source of absolute line
 * numbers. Fail-open: anything that isn't a unified diff returns undefined and
 * the view falls back to the `args.edits` blocks.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { DIFF_ROW_CLASS, parseUnifiedPatch } from "../../../src/components/toolViews/editView.tsx";

// Trimmed from a real session: two hunks separated by a skipped region.
const PATCH = `--- src/workspaceReducer.ts
+++ src/workspaceReducer.ts
@@ -93,3 +93,4 @@
     askUserPending: Record<string, true>;
     /**
+    pendingCommandPermissions: Record<string, CommandPermissionRequest>;
     /**
     * sessionId → task snapshot.
@@ -188,3 +189,4 @@
         askUserPending: {},
+        pendingCommandPermissions: {},
         agentToolPending: {},
         backgroundSubagents: {},
`;

describe("parseUnifiedPatch", () => {
    it("returns undefined for non-string / empty patch", () => {
        assert.equal(parseUnifiedPatch(undefined), undefined);
        assert.equal(parseUnifiedPatch(null), undefined);
        assert.equal(parseUnifiedPatch(42), undefined);
        assert.equal(parseUnifiedPatch(""), undefined);
        assert.equal(parseUnifiedPatch("   "), undefined);
    });

    it("returns undefined when there are file headers but no hunk", () => {
        assert.equal(parseUnifiedPatch("--- a.ts\n+++ b.ts\n"), undefined);
    });

    it("returns undefined for a body line that is not a unified-diff marker", () => {
        assert.equal(parseUnifiedPatch("@@ -1,1 +1,1 @@\njunk\n"), undefined);
    });

    it("numbers rows from the @@ header and increments per row", () => {
        const rows = parseUnifiedPatch(PATCH);
        assert.ok(rows);
        assert.deepEqual(
            rows?.filter((r) => r.kind !== "gap").map((r) => [r.kind, r.oldNum, r.newNum]),
            [
                ["ctx", 93, 93],
                ["ctx", 94, 94],
                ["add", undefined, 95],
                ["ctx", 95, 96],
                ["ctx", 96, 97],
                ["ctx", 188, 189],
                ["add", undefined, 190],
                ["ctx", 189, 191],
                ["ctx", 190, 192],
            ],
        );
    });

    it("inserts a gap between hunks that skip lines", () => {
        const rows = parseUnifiedPatch(PATCH);
        assert.equal(rows?.filter((r) => r.kind === "gap").length, 1);
    });

    it("inserts no gap between adjacent hunks", () => {
        // The first hunk consumes old lines 1-2, the next one starts at 3.
        const rows = parseUnifiedPatch(
            "@@ -1,2 +1,2 @@\n-a\n+b\n-c\n+d\n@@ -3,1 +3,1 @@\n-e\n+e\n",
        );
        assert.equal(
            rows?.some((r) => r.kind === "gap"),
            false,
        );
    });

    it("inserts a gap when the next hunk starts past the consumed lines", () => {
        // The first hunk consumes old lines 1-2, the next one starts at 4,
        // so line 3 was skipped.
        const rows = parseUnifiedPatch(
            "@@ -1,2 +1,2 @@\n-a\n+b\n-c\n+d\n@@ -4,1 +4,1 @@\n-e\n+e\n",
        );
        assert.equal(rows?.filter((r) => r.kind === "gap").length, 1);
    });

    it("keeps body text verbatim, including empty lines", () => {
        const rows = parseUnifiedPatch("@@ -1,2 +1,2 @@\n-a\n+\n-b\n+\n");
        assert.deepEqual(
            rows?.map((r) => r.text),
            ["a", "", "b", ""],
        );
    });

    it("skips the '\\ No newline at end of file' marker", () => {
        const rows = parseUnifiedPatch("@@ -1,1 +1,1 @@\n-a\n\\ No newline at end of file\n+b\n");
        assert.deepEqual(
            rows?.map((r) => [r.kind, r.text]),
            [
                ["del", "a"],
                ["add", "b"],
            ],
        );
    });

    it("parses @@ headers that omit the line counts", () => {
        const rows = parseUnifiedPatch("@@ -7 +9 @@\n-a\n+b\n");
        assert.deepEqual(
            rows?.map((r) => [r.kind, r.oldNum, r.newNum]),
            [
                ["del", 7, undefined],
                ["add", undefined, 9],
            ],
        );
    });

    it("leaves the old side unnumbered for a pure append to an empty file", () => {
        const rows = parseUnifiedPatch("@@ -0,0 +1,2 @@\n+a\n+b\n");
        assert.deepEqual(
            rows?.map((r) => [r.kind, r.oldNum, r.newNum]),
            [
                ["add", undefined, 1],
                ["add", undefined, 2],
            ],
        );
    });

    // A row kind whose class has no CSS rule renders untinted, which is how the
    // del/add → -old/-new rename once shipped as a diff with no red or green.
    it("every row class the view emits exists in toolCardDiff.css", () => {
        const css = readFileSync(
            new URL("../../../src/styles/toolCardDiff.css", import.meta.url),
            "utf-8",
        );
        for (const cls of Object.values(DIFF_ROW_CLASS)) {
            assert.ok(css.includes(`.${cls}`), `${cls} is not styled in toolCardDiff.css`);
        }
    });
});
