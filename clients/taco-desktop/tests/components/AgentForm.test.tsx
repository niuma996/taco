/**
 * AgentForm — the taco and Claude Code dialogs share one component but expose
 * different fields; each must save only what belongs to its runtime.
 */
import { strict as assert } from "node:assert";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

    it("refuses to save when the tool list names AskUserQuestion", async () => {
        const onSave = vi.fn<(v: AgentFormValue) => void>();
        render(<AgentForm runtime="claude-code" onSave={onSave} onCancel={() => {}} />);
        const user = await fillRequired("coder");
        await user.type(
            screen.getByPlaceholderText("Read, Grep, Glob, Edit, Bash"),
            "AskUserQuestion",
        );
        assert.ok(screen.getByText("agents.form.ccToolBlocked"));
        assert.equal(
            (screen.getByText("agents.form.save").closest("button") as HTMLButtonElement).disabled,
            true,
        );
        assert.equal(onSave.mock.calls.length, 0);
    });

    // Bulk-set instead of typing: the values are far past the limits and
    // per-keystroke events would dominate the test's runtime. Each case starts
    // from a valid form, so the one over-limit field is what disables Save.
    const limitCases: Array<[string, (inputs: HTMLElement[]) => [HTMLElement, string]]> = [
        ["description", (inputs) => [inputs[1] as HTMLElement, "x".repeat(1025)]],
        ["whenToUse", (inputs) => [inputs[2] as HTMLElement, "x".repeat(2049)]],
        ["maxTurns", () => [screen.getByDisplayValue("30"), "201"]],
        ["systemPrompt", (inputs) => [inputs[inputs.length - 1] as HTMLElement, "x".repeat(65537)]],
    ];
    for (const [field, pick] of limitCases) {
        it(`disables save when ${field} exceeds the server limit`, () => {
            const onSave = vi.fn<(v: AgentFormValue) => void>();
            render(<AgentForm runtime="standard" onSave={onSave} onCancel={() => {}} />);
            const inputs = screen.getAllByRole("textbox");
            fireEvent.change(inputs[0] as HTMLElement, { target: { value: "limits" } });
            fireEvent.change(inputs[1] as HTMLElement, { target: { value: "does things" } });
            fireEvent.change(inputs[inputs.length - 1] as HTMLElement, {
                target: { value: "You do things." },
            });
            const save = screen
                .getByText("agents.form.save")
                .closest("button") as HTMLButtonElement;
            assert.equal(save.disabled, false, "baseline form must be savable");

            const [el, value] = pick(screen.getAllByRole("textbox"));
            fireEvent.change(el, { target: { value } });
            assert.equal(save.disabled, true);
            assert.equal(onSave.mock.calls.length, 0);
        });
    }

    it("starts a new definition at the runtime's default turn cap", () => {
        render(<AgentForm runtime="claude-code" onSave={() => {}} onCancel={() => {}} />);
        assert.ok(screen.getByDisplayValue("50"));
        cleanup();
        render(<AgentForm runtime="standard" onSave={() => {}} onCancel={() => {}} />);
        assert.ok(screen.getByDisplayValue("30"));
    });

    it("shows the no-user-questions rule in the Claude Code dialog", () => {
        render(<AgentForm runtime="claude-code" onSave={() => {}} onCancel={() => {}} />);
        assert.ok(screen.getByText("agents.form.ccRuleAskUser"));
        assert.ok(screen.getByText("agents.form.ccRuleCheckpoints"));
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

    // The switch is the only way to save without a role body — an empty prompt
    // on its own must stay unsavable, or a forgotten field silently produces a
    // role-less agent.
    describe("no role body switch", () => {
        it("refuses to save an empty prompt while the switch is off", async () => {
            const onSave = vi.fn<(v: AgentFormValue) => void>();
            render(<AgentForm runtime="standard" onSave={onSave} onCancel={() => {}} />);
            const user = userEvent.setup();
            const inputs = screen.getAllByRole("textbox");
            await user.type(inputs[0] as HTMLElement, "plain");
            await user.type(inputs[1] as HTMLElement, "does things");

            const save = screen
                .getByText("agents.form.save")
                .closest("button") as HTMLButtonElement;
            assert.equal(save.disabled, true);
            assert.equal(
                screen.getByRole("switch").getAttribute("aria-checked"),
                "false",
                "the switch must default to off on a new definition",
            );
        });

        it("saves an empty system prompt once the switch is on", async () => {
            const onSave = vi.fn<(v: AgentFormValue) => void>();
            render(<AgentForm runtime="standard" onSave={onSave} onCancel={() => {}} />);
            const user = userEvent.setup();
            const inputs = screen.getAllByRole("textbox");
            await user.type(inputs[0] as HTMLElement, "plain");
            await user.type(inputs[1] as HTMLElement, "does things");

            await user.click(screen.getByRole("switch"));
            assert.equal(screen.getByRole("switch").getAttribute("aria-checked"), "true");
            await user.click(screen.getByText("agents.form.save"));

            assert.equal(onSave.mock.calls[0]?.[0].systemPrompt, "");
        });

        it("disables the textarea without discarding a draft", async () => {
            render(<AgentForm runtime="standard" onSave={() => {}} onCancel={() => {}} />);
            const user = userEvent.setup();
            const inputs = screen.getAllByRole("textbox");
            await user.type(inputs[0] as HTMLElement, "plain");
            await user.type(inputs[1] as HTMLElement, "does things");
            await user.type(inputs[inputs.length - 1] as HTMLElement, "You do things.");

            await user.click(screen.getByRole("switch"));
            const textarea = inputs[inputs.length - 1] as HTMLTextAreaElement;
            assert.equal(textarea.disabled, true);
            assert.equal(textarea.value, "You do things.");

            await user.click(screen.getByRole("switch"));
            assert.equal(textarea.disabled, false);
            assert.equal(textarea.value, "You do things.");
        });

        it("edit starts with the switch on for a definition that has no body", () => {
            render(
                <AgentForm
                    runtime="standard"
                    existing={{
                        agentType: "roamer",
                        description: "d",
                        runtime: "standard",
                        maxTurns: 30,
                        systemPrompt: "",
                    }}
                    onSave={() => {}}
                    onCancel={() => {}}
                />,
            );
            assert.equal(screen.getByRole("switch").getAttribute("aria-checked"), "true");
        });
    });
});
