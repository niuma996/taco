/**
 * readView's countReadLines — the number shown on a successful `read` card.
 * The tool appends its own truncation note to the file body; the count must
 * describe the file, not the note.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { countReadLines } from "../../../src/components/toolViews/readView.tsx";

describe("countReadLines", () => {
    it("空结果 → 0 行", () => {
        assert.equal(countReadLines(""), 0);
    });

    it("单行无换行 → 1 行", () => {
        assert.equal(countReadLines("only line"), 1);
    });

    it("尾随换行不算额外一行", () => {
        assert.equal(countReadLines("a\nb\n"), 2);
    });

    it("行数截断提示不计入行数", () => {
        const body = "a\nb\nc";
        const note = "\n\n[Showing lines 1-3 of 900. Use offset=4 to continue.]";
        assert.equal(countReadLines(body + note), 3);
    });

    it("字节截断提示不计入行数", () => {
        const note = "\n\n[Showing lines 1-2 of 40 (50.0KB limit). Use offset=3 to continue.]";
        assert.equal(countReadLines(`a\nb${note}`), 2);
    });

    it("limit 剩余提示不计入行数", () => {
        assert.equal(
            countReadLines("a\nb\n\n[8 more lines in file. Use offset=3 to continue.]"),
            2,
        );
    });

    it("首行超限提示 → 提示本身不是文件内容,计 0 行", () => {
        const text =
            "[Line 5 is 60.0KB, exceeds 50.0KB limit. Use bash: sed -n '5p' f | head -c 51200]";
        assert.equal(countReadLines(text), 0);
    });
});
