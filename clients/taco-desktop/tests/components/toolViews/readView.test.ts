/**
 * readView's countReadLines — the number shown on a successful `read` card.
 * The tool appends its own truncation note to the file body; the count must
 * describe the file, not the note.
 *
 * NOTES below are copied verbatim from pi-agent-core's read tool
 * (dist/harness/tools/read.js). They are the contract this function reads
 * against: if an upgrade rewords or restructures them, these assertions fail
 * rather than the count silently drifting upward in the UI.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { countReadLines } from "../../../src/components/toolViews/readView.tsx";

/** Every truncation note the tool can emit, at the time of writing. */
const NOTES = {
    lineLimit: "\n\n[Showing lines 1-3 of 900. Use offset=4 to continue.]",
    byteLimit: "\n\n[Showing lines 1-2 of 40 (50.0KB limit). Use offset=3 to continue.]",
    remaining: "\n\n[8 more lines in file. Use offset=3 to continue.]",
    firstLineTooBig:
        "[Line 5 is 60.0KB, exceeds 50.0KB limit. Use bash: sed -n '5p' f | head -c 51200]",
} as const;

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
        assert.equal(countReadLines(`a\nb\nc${NOTES.lineLimit}`), 3);
    });

    it("字节截断提示不计入行数", () => {
        assert.equal(countReadLines(`a\nb${NOTES.byteLimit}`), 2);
    });

    it("limit 剩余提示不计入行数", () => {
        assert.equal(countReadLines(`a\nb${NOTES.remaining}`), 2);
    });

    it("首行超限提示 → 提示本身不是文件内容,计 0 行", () => {
        assert.equal(countReadLines(NOTES.firstLineTooBig), 0);
    });

    // Structural matching means a reworded note is still stripped — that is the
    // point of not keying on the tool's prose.
    it("提示措辞变化后仍能剥离", () => {
        assert.equal(countReadLines("a\nb\n\n[Truncated: some future wording here]"), 2);
    });

    it("文件正文里的方括号行不被误当作提示", () => {
        // No blank line before it, so it is content — a TOML section header,
        // a markdown link reference, etc.
        assert.equal(countReadLines("a\n[section]\nb"), 3);
    });
});
