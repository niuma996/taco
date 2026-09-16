/**
 * SubagentPanel integration test (vitest + @testing-library/react).
 *
 * Covers: list derivation from messages, selection, detached row disabled,
 * empty / no-match states, history lazy load with retry.
 *
 * Run:
 *   pnpm --filter @taco-ai/desktop test:subagent-panel
 */
import { strict as assert } from "node:assert";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, it, vi } from "vitest";

import { SubagentPanel } from "../../src/components/panels/SubagentPanel";
import { SubagentProvider } from "../../src/hooks/useSubagent";
import * as useI18n from "../../src/i18n/useI18n";
import type { UiMessage, UiToolCall } from "../../src/lib/chat/chatUtils";

// useT returns the key itself so assertions read against i18n keys.
vi.spyOn(useI18n, "useT").mockReturnValue({
    t: (key: string) => key,
} as unknown as ReturnType<typeof useI18n.useT>);

function asst(id: string, tools: UiToolCall[]): UiMessage {
    return { id, kind: "assistant", text: "", ts: 0, tools, thinking: [] };
}

function agentTool(over: Partial<UiToolCall> = {}): UiToolCall {
    return {
        id: "call-1",
        name: "agent",
        args: { subagent_type: "Explore", description: "查找配置", prompt: "去找配置" },
        status: "ok",
        details: { subSessionId: "sub-1", agentType: "Explore" },
        ...over,
    };
}

const userMsg: UiMessage = { id: "cm1", kind: "user", text: "子会话消息", ts: 0 };

afterEach(cleanup);

interface HarnessOpts {
    messages?: UiMessage[];
    selected?: string | null;
    live?: Record<string, UiMessage[]>;
    history?: Record<string, UiMessage[]>;
    loadHistory?: (subSessionId: string) => Promise<void>;
    onSelect?: (id: string) => void;
    onClose?: () => void;
}

function renderPanel(opts: HarnessOpts = {}) {
    const {
        messages = [asst("m1", [agentTool()])],
        selected = null,
        live = {},
        history = {},
        loadHistory = async () => {},
        onSelect = () => {},
        onClose = () => {},
    } = opts;

    return render(
        <SubagentProvider
            cwd="/proj"
            loadSubagentHistory={loadHistory}
            liveMessagesFor={(id) => live[id] ?? []}
            historyMessagesFor={(id) => history[id] ?? []}
            openInPanel={() => {}}
        >
            <SubagentPanel
                messages={messages}
                open={true}
                selectedSubSessionId={selected}
                onSelect={onSelect}
                onClose={onClose}
            />
        </SubagentProvider>,
    );
}

describe("SubagentPanel — 列表", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("open=false 时不渲染", () => {
        const { container } = render(
            <SubagentProvider
                cwd="/proj"
                loadSubagentHistory={async () => {}}
                liveMessagesFor={() => []}
                historyMessagesFor={() => []}
                openInPanel={() => {}}
            >
                <SubagentPanel
                    messages={[asst("m1", [agentTool()])]}
                    open={false}
                    selectedSubSessionId={null}
                    onSelect={() => {}}
                    onClose={() => {}}
                />
            </SubagentProvider>,
        );
        assert.equal(container.querySelector(".subagent-panel"), null);
    });

    it("从 messages 派生并渲染行", () => {
        renderPanel();
        assert.ok(screen.getByText("Explore"));
        assert.ok(screen.getByText("查找配置"));
    });

    it("无子代理时显示空态", () => {
        renderPanel({ messages: [] });
        assert.ok(screen.getByText("subagents.empty"));
    });

    it("无子代理时不显示「从上方选择」提示", () => {
        renderPanel({ messages: [] });
        assert.equal(screen.queryByText("subagents.selectPrompt"), null);
    });

    it("点击行触发 onSelect", async () => {
        const onSelect = vi.fn();
        renderPanel({ onSelect });
        await userEvent.click(screen.getByText("Explore"));
        assert.deepEqual(onSelect.mock.calls, [["sub-1"]]);
    });

    it("detached 行被禁用且不触发 onSelect", async () => {
        const onSelect = vi.fn();
        renderPanel({
            messages: [asst("m1", [agentTool({ details: undefined })])],
            onSelect,
        });
        const row = screen.getByRole("button", { name: /Explore/ });
        assert.equal((row as HTMLButtonElement).disabled, true);
        await userEvent.click(row);
        assert.equal(onSelect.mock.calls.length, 0);
    });

    it("搜索无命中显示 noMatch 而非 empty", async () => {
        renderPanel();
        await userEvent.click(screen.getByRole("button", { name: "pane.searchLabel" }));
        await userEvent.type(screen.getByRole("textbox", { name: "pane.searchLabel" }), "zzz");
        await waitFor(() => {
            assert.ok(screen.getByText("subagents.noMatch"));
        });
        assert.equal(screen.queryByText("subagents.empty"), null);
    });

    it("关闭按钮触发 onClose", async () => {
        const onClose = vi.fn();
        renderPanel({ onClose });
        await userEvent.click(screen.getByRole("button", { name: "app.dismiss" }));
        assert.equal(onClose.mock.calls.length, 1);
    });
});

describe("SubagentPanel — 详情", () => {
    it("未选中时提示从上方选择", () => {
        renderPanel();
        assert.ok(screen.getByText("subagents.selectPrompt"));
    });

    it("选中后渲染 prompt 与 live 消息", () => {
        renderPanel({ selected: "sub-1", live: { "sub-1": [userMsg] } });
        assert.ok(screen.getByText("subagents.promptLabel"));
        assert.ok(screen.getByText("去找配置"));
        assert.ok(screen.getByText("子会话消息"));
    });

    it("live 为空时触发 loadSubagentHistory 一次", async () => {
        const loadHistory = vi.fn(async () => {});
        renderPanel({ selected: "sub-1", loadHistory });
        await waitFor(() => {
            assert.deepEqual(loadHistory.mock.calls, [["sub-1"]]);
        });
    });

    it("live 非空时不拉历史", async () => {
        const loadHistory = vi.fn(async () => {});
        renderPanel({ selected: "sub-1", live: { "sub-1": [userMsg] }, loadHistory });
        await new Promise((r) => setTimeout(r, 20));
        assert.equal(loadHistory.mock.calls.length, 0);
    });

    it("加载成功但子会话为空 → noMessages（区别于失败）", async () => {
        renderPanel({ selected: "sub-1", loadHistory: async () => {} });
        await waitFor(() => {
            assert.ok(screen.getByText("subagents.noMessages"));
        });
        assert.equal(screen.queryByText(/subagents.historyFailed/), null);
    });

    it("加载失败显示错误 + 重试按钮，重试会再次调用", async () => {
        const loadHistory = vi
            .fn<(id: string) => Promise<void>>()
            .mockRejectedValueOnce(new Error("boom"))
            .mockResolvedValueOnce(undefined);
        renderPanel({ selected: "sub-1", loadHistory });

        await waitFor(() => {
            assert.ok(screen.getByText("subagents.retry"));
        });
        await userEvent.click(screen.getByText("subagents.retry"));
        await waitFor(() => {
            assert.equal(loadHistory.mock.calls.length, 2);
        });
    });

    it("history 有内容时渲染它（live 为空）", async () => {
        renderPanel({ selected: "sub-1", history: { "sub-1": [userMsg] } });
        await waitFor(() => {
            assert.ok(screen.getByText("子会话消息"));
        });
    });

    it("选中项指向不存在的 id → 回落到选择提示，不留残影", () => {
        renderPanel({ selected: "does-not-exist" });
        assert.ok(screen.getByText("subagents.selectPrompt"));
    });
});
