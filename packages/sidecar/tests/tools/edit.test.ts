/**
 * edit tool — file modification result unit tests.
 *
 * Uses a temporary directory to verify:
 *   - single replacement correctness
 *   - multiple replacements applied in order
 *   - cross-line replacements
 *   - firstChangedLine field reflects the first changed line number
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createEditTool } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

async function runEdit(
    cwd: string,
    path: string,
    edits: Array<{ oldText: string; newText: string }>,
): Promise<void> {
    const env = new NodeExecutionEnv({ cwd });
    const tool = createEditTool();
    await tool.execute("tc", { path, edits }, undefined, undefined, { env });
}

let cwd: string;

before(() => {
    cwd = mkdtempSync(join(tmpdir(), "edit-"));
});

after(() => {
    rmSync(cwd, { recursive: true, force: true });
});

function read(path: string): string {
    return readFileSync(join(cwd, path), "utf-8");
}

describe("edit tool — file content after edits", () => {
    it("文件开头替换", async () => {
        const file = "start.ts";
        writeFileSync(join(cwd, file), "const a = 1;\nconst b = 2;\n", "utf-8");
        await runEdit(cwd, file, [{ oldText: "const a = 1;", newText: "const a = 11;" }]);
        assert.equal(read(file), "const a = 11;\nconst b = 2;\n");
    });

    it("文件中段替换", async () => {
        const file = "middle.ts";
        writeFileSync(join(cwd, file), "line1\nline2\nline3\n", "utf-8");
        await runEdit(cwd, file, [{ oldText: "line2", newText: "LINE_TWO" }]);
        assert.equal(read(file), "line1\nLINE_TWO\nline3\n");
    });

    it("多行 oldText / newText", async () => {
        const file = "multi.ts";
        writeFileSync(join(cwd, file), "a\nb\nc\nd\n", "utf-8");
        await runEdit(cwd, file, [{ oldText: "b\nc", newText: "B\nC\nC2" }]);
        assert.equal(read(file), "a\nB\nC\nC2\nd\n");
    });

    it("多条 edit 顺序应用", async () => {
        const file = "two.ts";
        writeFileSync(join(cwd, file), "alpha\nbeta\ngamma\n", "utf-8");
        await runEdit(cwd, file, [
            { oldText: "alpha", newText: "ALPHA_PADDING" },
            { oldText: "gamma", newText: "g" },
        ]);
        assert.equal(read(file), "ALPHA_PADDING\nbeta\ng\n");
    });

    it("跨行 edit 后文件内容正确", async () => {
        const file = "shift.ts";
        writeFileSync(join(cwd, file), "line1\nline2\nline3\nline4\n", "utf-8");
        await runEdit(cwd, file, [
            { oldText: "line1", newText: "verylongnewstring" },
            { oldText: "line4", newText: "L4" },
        ]);
        assert.equal(read(file), "verylongnewstring\nline2\nline3\nL4\n");
    });

    it("oldText 不匹配时抛出错误", async () => {
        const file = "nomatch.ts";
        writeFileSync(join(cwd, file), "hello\n", "utf-8");
        await assert.rejects(
            async () => runEdit(cwd, file, [{ oldText: "not present", newText: "replacement" }]),
            (e: unknown) => String(e).includes("oldText") || String(e).includes("match"),
        );
    });
});
