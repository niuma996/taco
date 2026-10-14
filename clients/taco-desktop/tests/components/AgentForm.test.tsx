/**
 * AgentForm — the taco and Claude Code dialogs share one component but expose
 * different fields; each must save only what belongs to its runtime.
 */
import { strict as assert } from "node:assert";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, it, vi } from "vitest";

import { AgentForm, type AgentFormValue } from "../../src/components/agents/AgentForm";
import * as useI18n from "../../src/i18n/useI18n";

vi.spyOn(useI18n, "useT").mockReturnValue({
    t: (key: string) => key,
} as unknown as ReturnType<typeof useI18n.useT>);

afterEach(cleanup);

async function fillRequired(name: string) {
    const user = userEvent.setup();
    const inputs = screen.getAllByRole("textbox");
    // Order: name, description, whenToUse, [tools], maxTurns, systemPrompt.
    await user.type(inputs[0] as HTMLElement, name);
    await user.type(inputs[1] as HTMLElement, "does things");
    await user.type(inputs[inputs.length - 1] as HTMLElement, "You do things.");
    return user;
}

describe("AgentForm", () => {
    it("taco dialog: no Claude Code rules or fields, saves no Claude Code settings", async () => {
        const onSave = vi.fn<(v: AgentFormValue) => void>();
        render(<AgentForm runtime="standard" onSave={onSave} onCancel={() => {}} />);
        assert.equal(screen.queryByText("agents.form.ccRuleEngine"), null);
        assert.equal(screen.queryByText("agents.form.ccTools"), null);
        assert.equal(screen.queryByText("agents.form.ccPermissionMode"), null);

        const user = await fillRequired("plain");
        await user.click(screen.getByText("agents.form.save"));
        const saved = onSave.mock.calls[0]?.[0];
        assert.ok(saved);
        assert.equal(saved.runtime, "standard");
        assert.equal("tools" in saved, false);
        assert.equal("permissionMode" in saved, false);
    });

    it("Claude Code dialog: shows the rules, defaults to the full preset and auto", async () => {
        const onSave = vi.fn<(v: AgentFormValue) => void>();
        render(<AgentForm runtime="claude-code" onSave={onSave} onCancel={() => {}} />);
        assert.ok(screen.getByText("agents.form.newCcTitle"));
        assert.ok(screen.getByText("agents.form.ccRuleEngine"));
        assert.ok(screen.getByText("agents.form.ccRulePermissions"));

        const user = await fillRequired("coder");
        await user.click(screen.getByText("agents.form.save"));
        const saved = onSave.mock.calls[0]?.[0];
        assert.ok(saved);
        assert.equal(saved.runtime, "claude-code");
        assert.equal(saved.tools, undefined, "empty tools = Claude Code's preset");
        assert.equal(saved.permissionMode, "auto");
    });

    it("Claude Code dialog: parses a tool list and blocks invalid names", async () => {
        const onSave = vi.fn<(v: AgentFormValue) => void>();
        render(<AgentForm runtime="claude-code" onSave={onSave} onCancel={() => {}} />);
        const user = await fillRequired("coder");
        const toolsInput = screen.getByPlaceholderText("Read, Grep, Glob, Edit, Bash");

        await user.type(toolsInput, "Read; rm");
        assert.ok(screen.getByText("agents.form.ccToolsInvalid"));
        assert.equal(
            (screen.getByText("agents.form.save").closest("button") as HTMLButtonElement).disabled,
            true,
        );

        await user.clear(toolsInput);
        await user.type(toolsInput, "Read, Edit  Bash");
        await user.click(screen.getByText("agents.form.save"));
        assert.deepEqual(onSave.mock.calls[0]?.[0].tools, ["Read", "Edit", "Bash"]);
    });

    it("edit prefills Claude Code settings from the definition", () => {
        render(
            <AgentForm
                runtime="claude-code"
                existing={{
                    agentType: "coder",
                    description: "d",
                    runtime: "claude-code",
                    maxTurns: 30,
                    systemPrompt: "p",
                    tools: ["Read", "Edit"],
                    permissionMode: "acceptEdits",
                }}
                onSave={() => {}}
                onCancel={() => {}}
            />,
        );
        assert.ok(screen.getByText("agents.form.editCcTitle"));
        assert.equal(
            (screen.getByPlaceholderText("Read, Grep, Glob, Edit, Bash") as HTMLInputElement).value,
            "Read, Edit",
        );
        assert.ok(screen.getByText("agents.form.ccMode.acceptEditsHint"));
    });
});
