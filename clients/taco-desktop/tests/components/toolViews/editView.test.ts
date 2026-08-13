/**
 * editView's extractLineInfo — last safety valve on the reducer's details chain.
 * Fail-open: any malformed details returns undefined; UI falls back to per-edit
 * relative line numbers.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractLineInfo } from "../../../src/components/toolViews/editView.tsx";

describe("extractLineInfo", () => {
    it("空 details → undefined", () => {
        assert.equal(extractLineInfo(undefined, 1), undefined);
        assert.equal(extractLineInfo(null, 1), undefined);
    });

    it("details 非对象(数组/字符串) → undefined", () => {
        assert.equal(extractLineInfo([], 1), undefined);
        assert.equal(extractLineInfo("oops", 1), undefined);
        assert.equal(extractLineInfo(42, 1), undefined);
    });

    it("details 缺少 lines → undefined", () => {
        assert.equal(extractLineInfo({ edits: 3 }, 2), undefined);
    });

    it("lines 长度与 edits 数量不匹配 → undefined", () => {
        const details = { lines: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }] };
        assert.equal(extractLineInfo(details, 2), undefined);
    });

    it("lines 内单项字段类型错 → 整组 undefined", () => {
        const details = {
            lines: [
                { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 },
                { oldStart: "x", oldLines: 1, newStart: 1, newLines: 1 },
            ],
        };
        assert.equal(extractLineInfo(details, 2), undefined);
    });

    it("happy path:返回结构化 LineInfo", () => {
        const details = {
            lines: [
                { oldStart: 5, oldLines: 2, newStart: 5, newLines: 3 },
                { oldStart: 20, oldLines: 1, newStart: 23, newLines: 1 },
            ],
        };
        const out = extractLineInfo(details, 2);
        assert.ok(out);
        assert.deepEqual(out?.[0], { oldStart: 5, oldLines: 2, newStart: 5, newLines: 3 });
        assert.deepEqual(out?.[1], { oldStart: 20, oldLines: 1, newStart: 23, newLines: 1 });
    });
});
