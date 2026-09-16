/**
 * Per-tool summary overrides — the head's input digest for tools whose useful
 * argument is not one of the default's guessed field names.
 *
 * Importing the entry point registers every view, so these assertions go
 * through the same resolveToolView path the card uses.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import "../../../src/components/toolViews/index.ts";
import { resolveToolView } from "../../../src/components/toolViews/registry.ts";
import type { UiToolCall } from "../../../src/lib/chat/chatUtils.ts";

function call(name: string, args: unknown): UiToolCall {
    return { id: "c1", name, args, status: "ok" };
}

/** Runs the registered summary for `name`, asserting one exists. */
function summarize(name: string, args: unknown): unknown {
    const spec = resolveToolView(name);
    assert.ok(spec?.summary, `${name} should declare a summary`);
    return spec.summary(call(name, args));
}

describe("grep / glob summary", () => {
    it("显示 pattern,而不是被 path 挤掉", () => {
        assert.equal(
            summarize("grep", { pattern: "createReadTool", path: "src" }),
            "createReadTool · src",
        );
    });

    it("省略 path 时只显示 pattern", () => {
        assert.equal(summarize("glob", { pattern: "src/**/*.ts" }), "src/**/*.ts");
    });

    it("长 path 走 shortPath 压缩", () => {
        const out = summarize("grep", {
            pattern: "x",
            path: "/a/very/long/absolute/path/to/some/dir",
        });
        assert.equal(typeof out, "string");
        assert.ok((out as string).includes("…"), `expected shortPath ellipsis, got ${out}`);
    });

    it("pattern 缺失 → 空(退回只显示工具名)", () => {
        assert.equal(summarize("grep", { path: "src" }), "");
        assert.equal(summarize("grep", {}), "");
    });
});

describe("todoWrite summary", () => {
    it("显示完成数/总数与进行中条目", () => {
        const todos = [
            { content: "a", status: "completed" },
            { content: "写 registry", status: "in_progress" },
            { content: "c", status: "pending" },
        ];
        assert.equal(summarize("todoWrite", { todos }), "1/3 · 写 registry");
    });

    it("failed 计入已完成(终态)", () => {
        const todos = [
            { content: "a", status: "failed" },
            { content: "b", status: "completed" },
        ];
        assert.equal(summarize("todoWrite", { todos }), "2/2");
    });

    it("无进行中条目时只显示进度", () => {
        assert.equal(
            summarize("todoWrite", { todos: [{ content: "a", status: "pending" }] }),
            "0/1",
        );
    });

    it("todos 不是数组 → 空", () => {
        assert.equal(summarize("todoWrite", { todos: "oops" }), "");
        assert.equal(summarize("todoWrite", {}), "");
    });
});

describe("taskCreate / taskUpdate summary", () => {
    it("taskCreate 显示列表名与进度", () => {
        const args = { listName: "重构工具卡片", tasks: [{ content: "a", status: "pending" }] };
        assert.equal(summarize("taskCreate", args), "重构工具卡片 · 0/1");
    });

    it("taskCreate 缺 tasks 时只显示列表名", () => {
        assert.equal(summarize("taskCreate", { listName: "L" }), "L");
    });

    it("taskUpdate 显示 taskId 与目标状态", () => {
        const args = { taskId: "t-3", updates: { status: "completed" } };
        assert.equal(summarize("taskUpdate", args), "t-3 · completed");
    });

    it("taskUpdate 只改内容时显示 taskId", () => {
        assert.equal(summarize("taskUpdate", { taskId: "t-3", updates: { content: "x" } }), "t-3");
    });
});

describe("summary suppression", () => {
    it("body 已渲染输入的工具把 summary 显式置空", () => {
        for (const name of ["shell", "agent", "askUser", "planExit"]) {
            assert.equal(summarize(name, { command: "ls", subagent_type: "Explore" }), null, name);
        }
    });

    it("read / edit 保留默认 path 摘要(未声明 summary)", () => {
        for (const name of ["read", "edit"]) {
            assert.equal(resolveToolView(name)?.summary, undefined, name);
        }
    });

    it("shell 注册在真实工具名下(旧的 bash/powershell 从未匹配)", () => {
        assert.ok(resolveToolView("shell")?.body, "shell should have a body");
        assert.equal(resolveToolView("bash"), undefined);
        assert.equal(resolveToolView("powershell"), undefined);
    });
});
