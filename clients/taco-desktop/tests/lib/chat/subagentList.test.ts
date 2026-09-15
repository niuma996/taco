/**
 * subagentList pure-function tests — Node 22 built-in `node:test` runner via tsx.
 *
 * Run:
 *   pnpm --filter @taco-ai/desktop test:subagent
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { UiMessage, UiToolCall } from "../../../src/lib/chat/chatUtils";
import {
    clampPanelWidth,
    deriveSubagents,
    filterSubagents,
    RIGHT_PANEL_DEFAULT_WIDTH,
    type SubagentEntry,
    shouldAutoOpen,
    subagentDotState,
} from "../../../src/lib/chat/subagentList";

/** Assistant message carrying the given tool calls; ts is irrelevant to derivation. */
function asst(id: string, tools: UiToolCall[]): UiMessage {
    return { id, kind: "assistant", text: "", ts: 0, tools, thinking: [] };
}

function agentTool(over: Partial<UiToolCall> = {}): UiToolCall {
    return {
        id: "call-1",
        name: "agent",
        args: { subagent_type: "Explore", description: "查找 xx", prompt: "去找 xx" },
        status: "running",
        details: { subSessionId: "sub-1", agentType: "Explore" },
        ...over,
    };
}

describe("deriveSubagents — 基本抽取", () => {
    it("从 agent 工具调用抽出条目", () => {
        const out = deriveSubagents([asst("m1", [agentTool()])]);
        assert.equal(out.length, 1);
        assert.deepEqual(out[0], {
            subSessionId: "sub-1",
            agentType: "Explore",
            description: "查找 xx",
            prompt: "去找 xx",
            status: "running",
            firstToolCallId: "call-1",
        });
    });

    it("忽略非 agent 工具", () => {
        const shell: UiToolCall = { id: "c2", name: "shell", args: {}, status: "ok" };
        assert.equal(deriveSubagents([asst("m1", [shell])]).length, 0);
    });

    it("跳过 user / system / tool 类型消息", () => {
        const msgs: UiMessage[] = [
            { id: "u1", kind: "user", text: "hi", ts: 0 },
            { id: "s1", kind: "system", text: "x", ts: 0 },
            { id: "t1", kind: "tool", text: "orphan", ts: 0 },
        ];
        assert.equal(deriveSubagents(msgs).length, 0);
    });

    it("空输入返回空数组", () => {
        assert.deepEqual(deriveSubagents([]), []);
    });
});

describe("deriveSubagents — 状态映射", () => {
    it("running / ok / error 直接映射", () => {
        const out = deriveSubagents([
            asst("m1", [
                agentTool({ id: "c1", status: "running", details: { subSessionId: "s1" } }),
                agentTool({ id: "c2", status: "ok", details: { subSessionId: "s2" } }),
                agentTool({ id: "c3", status: "error", details: { subSessionId: "s3" } }),
            ]),
        ]);
        assert.deepEqual(
            out.map((e) => e.status),
            ["running", "ok", "error"],
        );
    });

    it("缺 subSessionId 一律 detached，即便工具还在 running", () => {
        const out = deriveSubagents([
            asst("m1", [agentTool({ status: "running", details: undefined })]),
        ]);
        assert.equal(out[0]?.status, "detached");
        assert.equal(out[0]?.subSessionId, null);
    });

    it("details 存在但 subSessionId 非字符串 → detached", () => {
        const out = deriveSubagents([asst("m1", [agentTool({ details: { subSessionId: 42 } })])]);
        assert.equal(out[0]?.status, "detached");
    });
});

describe("deriveSubagents — agentContinue 去重", () => {
    it("同 subSessionId 合并为一条，取首次的 description、末次的 status", () => {
        const out = deriveSubagents([
            asst("m1", [
                agentTool({
                    id: "c1",
                    status: "ok",
                    args: { subagent_type: "Explore", description: "首次描述", prompt: "P1" },
                }),
            ]),
            asst("m2", [
                {
                    id: "c2",
                    name: "agentContinue",
                    args: { subSessionId: "sub-1", prompt: "P2" },
                    status: "running",
                    details: { subSessionId: "sub-1" },
                },
            ]),
        ]);
        assert.equal(out.length, 1);
        assert.equal(out[0]?.description, "首次描述");
        assert.equal(out[0]?.prompt, "P1");
        assert.equal(out[0]?.status, "running");
        assert.equal(out[0]?.firstToolCallId, "c1");
    });

    it("agentContinue 独立出现（父卡片不在本分支）也建条目", () => {
        const out = deriveSubagents([
            asst("m1", [
                {
                    id: "c1",
                    name: "agentContinue",
                    args: { subSessionId: "sub-9", prompt: "继续" },
                    status: "ok",
                    details: { subSessionId: "sub-9" },
                },
            ]),
        ]);
        assert.equal(out.length, 1);
        assert.equal(out[0]?.subSessionId, "sub-9");
        assert.equal(out[0]?.agentType, "agent");
        assert.equal(out[0]?.description, "");
    });

    it("多个 detached 各自成行，不互相合并", () => {
        const out = deriveSubagents([
            asst("m1", [
                agentTool({ id: "c1", details: undefined }),
                agentTool({ id: "c2", details: undefined }),
            ]),
        ]);
        assert.equal(out.length, 2);
    });
});

describe("deriveSubagents — 字段回落", () => {
    it("agentType 取 details 优先，其次 args.subagent_type，最后 'agent'", () => {
        const out = deriveSubagents([
            asst("m1", [
                agentTool({
                    id: "c1",
                    details: { subSessionId: "s1", agentType: "FromDetails" },
                    args: { subagent_type: "FromArgs" },
                }),
                agentTool({
                    id: "c2",
                    details: { subSessionId: "s2" },
                    args: { subagent_type: "FromArgs" },
                }),
                agentTool({ id: "c3", details: { subSessionId: "s3" }, args: {} }),
            ]),
        ]);
        assert.deepEqual(
            out.map((e) => e.agentType),
            ["FromDetails", "FromArgs", "agent"],
        );
    });

    it("description / prompt 缺失回落空串", () => {
        const out = deriveSubagents([
            asst("m1", [agentTool({ args: {}, details: { subSessionId: "s1" } })]),
        ]);
        assert.equal(out[0]?.description, "");
        assert.equal(out[0]?.prompt, "");
    });

    it("args 为 null / 非对象时不抛，回落空串", () => {
        const out = deriveSubagents([
            asst("m1", [agentTool({ id: "c1", args: null, details: { subSessionId: "s1" } })]),
            asst("m2", [agentTool({ id: "c2", args: "oops", details: { subSessionId: "s2" } })]),
        ]);
        assert.equal(out.length, 2);
        assert.equal(out[0]?.description, "");
        assert.equal(out[1]?.description, "");
    });
});

describe("deriveSubagents — 容错与顺序", () => {
    it("坏项被跳过，其余条目仍然产出", () => {
        const broken = { id: "bad", name: "agent" } as unknown as UiToolCall;
        const out = deriveSubagents([asst("m1", [broken, agentTool({ id: "c2" })])]);
        assert.equal(out.length, 1);
        assert.equal(out[0]?.firstToolCallId, "c2");
    });

    it("tools 字段缺失的 assistant 消息不抛", () => {
        const msg = {
            id: "m1",
            kind: "assistant",
            text: "",
            ts: 0,
            thinking: [],
        } as unknown as UiMessage;
        assert.deepEqual(deriveSubagents([msg]), []);
    });

    it("顺序与消息流一致（按首次出现）", () => {
        const out = deriveSubagents([
            asst("m1", [agentTool({ id: "c1", details: { subSessionId: "s1" } })]),
            asst("m2", [agentTool({ id: "c2", details: { subSessionId: "s2" } })]),
            asst("m3", [agentTool({ id: "c3", details: { subSessionId: "s1" } })]),
        ]);
        assert.deepEqual(
            out.map((e) => e.subSessionId),
            ["s1", "s2"],
        );
    });
});

describe("filterSubagents", () => {
    const entries: SubagentEntry[] = [
        {
            subSessionId: "s1",
            agentType: "Explore",
            description: "查找配置",
            prompt: "",
            status: "ok",
            firstToolCallId: "c1",
        },
        {
            subSessionId: "s2",
            agentType: "Plan",
            description: "设计方案",
            prompt: "",
            status: "running",
            firstToolCallId: "c2",
        },
    ];

    it("空 query 返回全部", () => {
        assert.equal(filterSubagents(entries, "").length, 2);
        assert.equal(filterSubagents(entries, "   ").length, 2);
    });

    it("匹配 agentType，大小写不敏感", () => {
        assert.equal(filterSubagents(entries, "explore").length, 1);
    });

    it("匹配 description", () => {
        assert.equal(filterSubagents(entries, "设计").length, 1);
    });

    it("无命中返回空数组", () => {
        assert.deepEqual(filterSubagents(entries, "zzz"), []);
    });
});

describe("subagentDotState", () => {
    const mk = (status: SubagentEntry["status"]): SubagentEntry => ({
        subSessionId: "s",
        agentType: "a",
        description: "",
        prompt: "",
        status,
        firstToolCallId: "c",
    });

    it("空列表 → none", () => {
        assert.equal(subagentDotState([]), "none");
    });

    it("有 running → active", () => {
        assert.equal(subagentDotState([mk("ok"), mk("running")]), "active");
    });

    it("全终态 → idle", () => {
        assert.equal(subagentDotState([mk("ok"), mk("error"), mk("detached")]), "idle");
    });
});

describe("shouldAutoOpen", () => {
    const running = (id: string): SubagentEntry => ({
        subSessionId: id,
        agentType: "Explore",
        description: "",
        prompt: "",
        status: "running",
        firstToolCallId: `c-${id}`,
    });
    const done = (id: string): SubagentEntry => ({ ...running(id), status: "ok" });
    const detached: SubagentEntry = {
        subSessionId: null,
        agentType: "Explore",
        description: "",
        prompt: "",
        status: "detached",
        firstToolCallId: "c-x",
    };

    it("新出现的 running 子代理 → 返回其 id", () => {
        assert.equal(shouldAutoOpen(new Set(), [running("s1")], false), "s1");
    });

    it("已在上一次集合里的 running 不触发", () => {
        assert.equal(shouldAutoOpen(new Set(["s1"]), [running("s1")], false), null);
    });

    it("本轮已自动开过 → 不再触发", () => {
        assert.equal(shouldAutoOpen(new Set(), [running("s1")], true), null);
    });

    it("历史回放（新增但已是终态）不触发", () => {
        assert.equal(shouldAutoOpen(new Set(), [done("s1"), done("s2")], false), null);
    });

    it("detached（无 subSessionId）不触发", () => {
        assert.equal(shouldAutoOpen(new Set(), [detached], false), null);
    });

    it("同一 tick 多个新 running 只取第一个", () => {
        assert.equal(shouldAutoOpen(new Set(), [running("s1"), running("s2")], false), "s1");
    });

    it("混合：跳过已知的与终态的，命中第一个新 running", () => {
        const next = [done("s0"), running("s1"), running("s2")];
        assert.equal(shouldAutoOpen(new Set(["s1"]), next, false), "s2");
    });
});

describe("clampPanelWidth", () => {
    it("区间内原值返回", () => {
        assert.equal(clampPanelWidth(300, 1440), 300);
    });

    it("低于下限夹到 220", () => {
        assert.equal(clampPanelWidth(100, 1440), 220);
    });

    it("高于上限夹到 640", () => {
        assert.equal(clampPanelWidth(9999, 1440), 640);
    });

    it("窄视口时上限退为 50vw", () => {
        assert.equal(clampPanelWidth(600, 800), 400);
    });

    it("极窄视口下限优先，保证不小于 220", () => {
        assert.equal(clampPanelWidth(300, 300), 220);
    });

    it("非数字 / NaN / 负数 / undefined 回落默认值", () => {
        assert.equal(clampPanelWidth(undefined, 1440), RIGHT_PANEL_DEFAULT_WIDTH);
        assert.equal(clampPanelWidth("300", 1440), RIGHT_PANEL_DEFAULT_WIDTH);
        assert.equal(clampPanelWidth(Number.NaN, 1440), RIGHT_PANEL_DEFAULT_WIDTH);
        assert.equal(clampPanelWidth(Number.POSITIVE_INFINITY, 1440), 640);
        assert.equal(clampPanelWidth(-5, 1440), 220);
    });

    it("视口宽度非法时按默认视口处理，不返回 NaN", () => {
        const v = clampPanelWidth(300, Number.NaN);
        assert.ok(Number.isFinite(v));
        assert.equal(v, 300);
    });
});
