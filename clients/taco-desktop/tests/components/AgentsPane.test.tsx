/**
 * AgentsPane — delete confirmation behaviour: a failed delete must surface its
 * error inside the still-open dialog (the pane is behind a modal scrim, so an
 * error banner outside it would be invisible), and a busy delete must not offer
 * a second click or a way out.
 */
import { strict as assert } from "node:assert";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, it, vi } from "vitest";

import * as useI18n from "../../src/i18n/useI18n";
import { AgentsPane } from "../../src/views/AgentsPane";

vi.mock("react-i18next", () => ({
    useTranslation: vi.fn(() => ({ t: (key: string) => key, i18n: { language: "en" } })),
}));
vi.spyOn(useI18n, "useT").mockReturnValue({
    t: (key: string) => key,
} as unknown as ReturnType<typeof useI18n.useT>);

afterEach(cleanup);

const agent = {
    agentType: "my-agent",
    description: "does things",
    source: "user" as const,
    editable: true,
};

function paneProps(onDeleteAgent: () => Promise<void>, saving: boolean) {
    return {
        agents: [agent],
        error: null,
        selectedAgentType: agent.agentType,
        onSelect: () => {},
        // No content: the delete flow never reads it, and rendering the system
        // prompt would pull shiki into a test that has no use for markdown.
        content: null,
        contentLoading: false,
        contentError: null,
        saving,
        onSaveAgent: async () => {},
        onDeleteAgent,
    };
}

describe("AgentsPane — 删除确认", () => {
    it("删除失败时错误显示在对话框内且对话框保持打开", async () => {
        render(
            <AgentsPane
                {...paneProps(async () => {
                    throw new Error("delete failed: EACCES");
                }, false)}
            />,
        );
        fireEvent.click(screen.getByText("agents.delete"));
        // Two "agents.delete" nodes now exist (pane button + dialog confirm);
        // the dialog's confirm is the one inside the dialog role.
        const dialog = await screen.findByRole("dialog");
        const confirm = dialog.querySelector(".ui-modal-actions button:last-child");
        assert.ok(confirm);
        fireEvent.click(confirm);

        await waitFor(() => {
            const shown = screen.getAllByText("delete failed: EACCES");
            assert.ok(shown.length > 0);
            assert.ok(
                dialog.contains(shown[0] as HTMLElement),
                "error must render inside the dialog, not behind the scrim",
            );
        });
        assert.ok(screen.getByRole("dialog"), "dialog stays open so the user can retry");
    });

    it("删除进行中禁用确认与取消，避免重复提交", async () => {
        const { rerender } = render(<AgentsPane {...paneProps(async () => {}, false)} />);
        fireEvent.click(screen.getByText("agents.delete"));
        await screen.findByRole("dialog");
        // `saving` flips while the RPC is in flight, with the dialog still open.
        rerender(<AgentsPane {...paneProps(() => new Promise<void>(() => {}), true)} />);
        const dialog = screen.getByRole("dialog");
        const buttons = [...dialog.querySelectorAll("button")];
        assert.equal(buttons.length, 2);
        for (const b of buttons) assert.equal((b as HTMLButtonElement).disabled, true);
    });

    it("重新打开对话框时不残留上一次的删除错误", async () => {
        render(
            <AgentsPane
                {...paneProps(async () => {
                    throw new Error("delete failed: EACCES");
                }, false)}
            />,
        );
        fireEvent.click(screen.getByText("agents.delete"));
        const dialog = await screen.findByRole("dialog");
        const confirm = dialog.querySelector(".ui-modal-actions button:last-child");
        assert.ok(confirm);
        fireEvent.click(confirm);
        await screen.findByText("delete failed: EACCES");

        fireEvent.click(dialog.querySelector(".ui-modal-actions button:first-child") as Element);
        await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
        fireEvent.click(screen.getByText("agents.delete"));
        await screen.findByRole("dialog");
        assert.equal(screen.queryByText("delete failed: EACCES"), null);
    });
});
