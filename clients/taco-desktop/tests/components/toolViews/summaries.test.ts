/**
 * Per-tool summary overrides — the head's input digest for tools whose useful
 * argument is not one of the default's guessed field names.
 *
 * Importing the entry point registers every view, so these assertions go
 * through the same resolveToolView path the card uses.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { defaultSummary } from "../../../src/components/toolViews/defaults.tsx";
import "../../../src/components/toolViews/index.ts";
import { resolveToolView } from "../../../src/components/toolViews/registry.ts";
import type { UiToolCall } from "../../../src/lib/chat/chatUtils.ts";

function call(name: string, args: unknown, rest: Partial<UiToolCall> = {}): UiToolCall {
    return { id: "c1", name, args, status: "ok", ...rest };
}

/**
 * Runs the registered summary for `name`, asserting one exists. `rest` carries
 * the fields a summary may read besides args — `details` for tools whose
 * resolved values only appear in the result, `status` for running cards.
 */
function summarize(name: string, args: unknown, rest: Partial<UiToolCall> = {}): unknown {
    const spec = resolveToolView(name);
    assert.ok(spec?.summary, `${name} should declare a summary`);
    return spec.summary(call(name, args, rest));
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

describe("skill summary", () => {
    it("展示已加载的 skill 名称(来自 details)", () => {
        const details = { skillName: "design-sync", found: true, runAs: "inline" };
        assert.equal(summarize("skill", { skill: "design-sync" }, { details }), "design-sync");
    });

    it("details 优先于 args(以真正解析到的名字为准)", () => {
        const details = { skillName: "resolved-name", found: true };
        assert.equal(summarize("skill", { skill: "typed-name" }, { details }), "resolved-name");
    });

    it("running 态还没有 details 时回退到 args.skill", () => {
        assert.equal(
            summarize("skill", { skill: "design-sync" }, { status: "running" }),
            "design-sync",
        );
    });

    it("subagent skill 标注执行位置", () => {
        const details = { skillName: "fan-out", found: true, runAs: "subagent" };
        assert.equal(summarize("skill", { skill: "fan-out" }, { details }), "fan-out · subagent");
    });

    it("skill 未找到时仍显示请求的名字", () => {
        const details = { skillName: "nope", found: false };
        assert.equal(summarize("skill", { skill: "nope" }, { details }), "nope");
    });

    it("名字缺失 → 空(退回只显示工具名)", () => {
        assert.equal(summarize("skill", {}), "");
        assert.equal(summarize("skill", { skill: 42 }), "");
    });
});

/**
 * The default summary never dumps JSON. Tools with a conventional argument name
 * get a digest for free; everything else shows just the tool name, and its exact
 * arguments live in the card's raw-args disclosure.
 *
 * This is what makes per-tool summaries optional rather than mandatory: a new
 * tool with no registry entry is already presentable.
 */
describe("default summary never dumps JSON", () => {
    /** Tools with no registry entry at all, so they exercise the default. */
    const UNREGISTERED = [
        "memory",
        "agentContinue",
        "addTools",
        "jobsCreate",
        "jobsUpdate",
        "jobsGet",
        "jobsDelete",
        "jobsRunNow",
        "planEnter",
        "taskList",
        "jobsList",
    ];

    it("这些工具不注册 summary,走默认", () => {
        for (const name of UNREGISTERED) {
            assert.equal(resolveToolView(name)?.summary, undefined, name);
        }
    });

    it("结构化入参 → 头部为空,而不是 JSON 片段", () => {
        const cases: unknown[] = [
            { action: "add", id: "my-topic" },
            { job: { name: "nightly-sync", schedule: { kind: "cron", expr: "0 3 * * *" } } },
            { toolNames: "grep, glob" },
            { subSessionId: "s-1", prompt: "keep going" },
            {},
        ];
        for (const args of cases) {
            const out = defaultSummary(call("anyTool", args));
            assert.equal(out, "", `expected no head digest, got: ${out}`);
        }
    });

    it("入参含常规字段名时仍给出摘要", () => {
        assert.equal(defaultSummary(call("x", { command: "ls -la" })), "ls -la");
        assert.ok(defaultSummary(call("x", { path: "/a/b/c.ts" })).length > 0);
        assert.ok(defaultSummary(call("x", { file_path: "/a/b/c.ts" })).length > 0);
    });

    it("args 不是对象 → 空", () => {
        assert.equal(defaultSummary(call("x", null)), "");
        assert.equal(defaultSummary(call("x", "raw")), "");
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
