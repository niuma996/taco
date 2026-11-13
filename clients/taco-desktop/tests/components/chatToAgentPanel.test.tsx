import { strict as assert } from "node:assert";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, test, vi } from "vitest";
import { SubagentPanel } from "../../src/components/panels/SubagentPanel";
import { SubagentProvider } from "../../src/hooks/useSubagent";
import type { UiMessage } from "../../src/lib/chat/chatUtils";

vi.mock("../../src/i18n/useI18n", () => ({ useT: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);

test("each completed continuation reloads the child even when the panel already has a live tail", async () => {
    const load = vi.fn(async () => {});
    const live: UiMessage[] = [{ id: "tail", kind: "user", ts: 1, text: "live tail" }];
    const scene = (runId: string) => {
        const messages: UiMessage[] = [
            {
                id: "parent",
                kind: "assistant",
                ts: 1,
                text: "",
                thinking: [],
                tools: [
                    {
                        id: "spawn",
                        name: "agent",
                        args: { subagent_type: "reviewer" },
                        status: "ok",
                        details: { subSessionId: "child" },
                    },
                    {
                        id: `send-${runId}`,
                        name: "chatToAgent",
                        args: { subSessionId: "child" },
                        status: "ok",
                        details: { subSessionId: "child", status: "completed", runId },
                    },
                ],
            },
        ];
        return (
            <SubagentProvider
                cwd="/w"
                loadSubagentHistory={load}
                liveMessagesFor={() => live}
                historyMessagesFor={() => []}
                openInPanel={() => {}}
            >
                <SubagentPanel
                    messages={messages}
                    open
                    selectedSubSessionId="child"
                    onSelect={() => {}}
                    onClose={() => {}}
                />
            </SubagentProvider>
        );
    };
    const view = render(scene("run-1"));
    await waitFor(() => assert.equal(load.mock.calls.length, 1));
    view.rerender(scene("run-2"));
    await waitFor(() => assert.equal(load.mock.calls.length, 2));
    assert.ok(screen.getByText("live tail"));
});
