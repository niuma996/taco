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

const base = {
    hasProjectDir: true,
    shadowedTypes: [] as string[],
    cwdChoices: ["/work/repo", "/work/assoc"],
};

async function fillRequired(name: string) {
    const user = userEvent.setup({ delay: null });
    const inputs = screen.getAllByRole("textbox");
    // Order: name, description, whenToUse, [tools], maxTurns, systemPrompt.
    await user.type(inputs[0] as HTMLElement, name);
    await user.type(inputs[1] as HTMLElement, "does things");
    await user.type(inputs[inputs.length - 1] as HTMLElement, "You do things.");
    return user;
}

describe("AgentForm", () => {
    it("locks creation to the scope selected in the pane", async () => {
        const onSave = vi.fn<(v: AgentFormValue) => void>();
        render(
            <AgentForm
                {...base}
                runtime="standard"
                fixedScope="workspace"
                onSave={onSave}
                onCancel={() => {}}
            />,
        );
        assert.equal(screen.queryByRole("combobox", { name: "agents.form.scope" }), null);
        const user = await fillRequired("local");
        await user.click(screen.getByText("agents.form.save"));
        assert.equal(onSave.mock.calls[0]?.[0].scope, "workspace");
    });

    it("taco dialog: no Claude Code rules or fields, saves no Claude Code settings", async () => {
        const onSave = vi.fn<(v: AgentFormValue) => void>();
        render(<AgentForm {...base} runtime="standard" onSave={onSave} onCancel={() => {}} />);
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
        render(<AgentForm {...base} runtime="claude-code" onSave={onSave} onCancel={() => {}} />);
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

    it("Codex dialog: saves explicit engine fields and the managed cwd", async () => {
        const onSave = vi.fn<(v: AgentFormValue) => void>();
        render(
            <AgentForm
                {...base}
                runtime="codex"
                codexRuntimeStatus={{
                    runtime: "codex",
                    installed: false,
                    auth: "unknown",
                    installer: "available",
                }}
                onSave={onSave}
                onCancel={() => {}}
            />,
        );
        assert.ok(screen.getByText("agents.form.newCodexTitle"));
        assert.ok(screen.getByText("agents.form.codexRuleDelivery"));
        assert.ok(screen.getByText("agents.form.codexInstall"));

        const user = await fillRequired("codex-reviewer");
        await user.type(screen.getByPlaceholderText("agents.form.codexModelPlaceholder"), "gpt-6");
        await user.click(screen.getByText("agents.form.save"));
        const saved = onSave.mock.calls[0]?.[0];
        assert.ok(saved);
        assert.equal(saved.runtime, "codex");
        assert.deepEqual(saved.codex, {
            cwd: "/work/repo",
            model: "gpt-6",
            sandbox: "read-only",
            approvalPolicy: "never",
        });
        assert.equal("permissionMode" in saved, false);
    });

    it("Codex dialog: installs the runtime and explains a signed-out install", async () => {
        const onInstallCodex = vi.fn();
        const onRefreshCodexRuntime = vi.fn();
        const { rerender } = render(
            <AgentForm
                {...base}
                runtime="codex"
                codexRuntimeStatus={{ runtime: "codex", installed: false, auth: "unknown" }}
                onInstallCodex={onInstallCodex}
                onSave={() => {}}
                onCancel={() => {}}
            />,
        );
        fireEvent.click(screen.getByText("agents.form.codexInstall"));
        assert.equal(onInstallCodex.mock.calls.length, 1);

        rerender(
            <AgentForm
                {...base}
                runtime="codex"
                codexRuntimeStatus={{
                    runtime: "codex",
                    installed: true,
                    version: "0.167.2",
                    auth: "signed-out",
                }}
                onInstallCodex={onInstallCodex}
                onRefreshCodexRuntime={onRefreshCodexRuntime}
                onSave={() => {}}
                onCancel={() => {}}
            />,
        );
        assert.ok(screen.getByText("agents.form.codexSignedOut"));
        fireEvent.click(screen.getByText("agents.form.codexRefreshStatus"));
        assert.equal(onRefreshCodexRuntime.mock.calls.length, 1);

        rerender(
            <AgentForm
                {...base}
                runtime="codex"
                codexRuntimeStatus={{
                    runtime: "codex",
                    installed: true,
                    version: "0.167.2",
                    auth: "unknown",
                }}
                onInstallCodex={onInstallCodex}
                onRefreshCodexRuntime={onRefreshCodexRuntime}
                onSave={() => {}}
                onCancel={() => {}}
            />,
        );
        assert.ok(screen.getByText("agents.form.codexAuthUnknown"));
    });

    it("edit prefills Codex engine settings", () => {
        render(
            <AgentForm
                {...base}
                runtime="codex"
                existing={{
                    scope: "global",
                    agentType: "codex-reviewer",
                    description: "d",
                    runtime: "codex",
                    maxTurns: 30,
                    systemPrompt: "p",
                    codex: {
                        cwd: "/work/assoc",
                        model: "gpt-6",
                        sandbox: "workspace-write",
                        approvalPolicy: "on-request",
                    },
                }}
                onSave={() => {}}
                onCancel={() => {}}
            />,
        );
        assert.ok(screen.getByText("agents.form.editCodexTitle"));
        assert.equal(
            (screen.getByPlaceholderText("agents.form.codexModelPlaceholder") as HTMLInputElement)
                .value,
            "gpt-6",
        );
    });

    it("Claude Code dialog: parses a tool list and blocks invalid names", async () => {
        const onSave = vi.fn<(v: AgentFormValue) => void>();
        render(<AgentForm {...base} runtime="claude-code" onSave={onSave} onCancel={() => {}} />);
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
        render(<AgentForm {...base} runtime="claude-code" onSave={onSave} onCancel={() => {}} />);
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
        ["maxTurns", () => [screen.getByDisplayValue("100"), "501"]],
        ["systemPrompt", (inputs) => [inputs[inputs.length - 1] as HTMLElement, "x".repeat(65537)]],
    ];
    for (const [field, pick] of limitCases) {
        it(`disables save when ${field} exceeds the server limit`, () => {
            const onSave = vi.fn<(v: AgentFormValue) => void>();
            render(<AgentForm {...base} runtime="standard" onSave={onSave} onCancel={() => {}} />);
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

    it("starts a new definition at the default turn cap", () => {
        render(<AgentForm {...base} runtime="claude-code" onSave={() => {}} onCancel={() => {}} />);
        assert.ok(screen.getByDisplayValue("100"));
        cleanup();
        render(<AgentForm {...base} runtime="standard" onSave={() => {}} onCancel={() => {}} />);
        assert.ok(screen.getByDisplayValue("100"));
    });

    it("leaves the timeout empty so the daemon derives it, and saves an explicit one", async () => {
        const onSave = vi.fn<(v: AgentFormValue) => void>();
        render(<AgentForm {...base} runtime="standard" onSave={onSave} onCancel={() => {}} />);
        assert.ok(screen.getByPlaceholderText("agents.form.timeoutMinutesAuto"));

        const user = await fillRequired("plain");
        await user.click(screen.getByText("agents.form.save"));
        const saved = onSave.mock.calls[0]?.[0];
        assert.ok(saved);
        assert.equal(
            "timeoutMinutes" in saved,
            false,
            "an empty field means the daemon derives the budget",
        );

        const timeoutInput = screen.getByPlaceholderText("agents.form.timeoutMinutesAuto");
        await user.clear(timeoutInput);
        await user.type(timeoutInput, "45");
        await user.click(screen.getByText("agents.form.save"));
        assert.equal(onSave.mock.calls[1]?.[0]?.timeoutMinutes, 45);
    });

    it("refuses to save a timeout that is not a whole number of minutes", async () => {
        const onSave = vi.fn<(v: AgentFormValue) => void>();
        render(<AgentForm {...base} runtime="standard" onSave={onSave} onCancel={() => {}} />);
        const user = await fillRequired("plain");
        const timeoutInput = screen.getByPlaceholderText("agents.form.timeoutMinutesAuto");
        await user.type(timeoutInput, "0");
        await user.click(screen.getByText("agents.form.save"));
        assert.equal(onSave.mock.calls.length, 0);
    });

    it("shows the no-user-questions rule in the Claude Code dialog", () => {
        render(<AgentForm {...base} runtime="claude-code" onSave={() => {}} onCancel={() => {}} />);
        assert.ok(screen.getByText("agents.form.ccRuleAskUser"));
        assert.ok(screen.getByText("agents.form.ccRuleCheckpoints"));
    });

    it("edit prefills Claude Code settings from the definition", () => {
        render(
            <AgentForm
                {...base}
                runtime="claude-code"
                existing={{
                    scope: "global",
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
            render(<AgentForm {...base} runtime="standard" onSave={onSave} onCancel={() => {}} />);
            const user = userEvent.setup({ delay: null });
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
            render(<AgentForm {...base} runtime="standard" onSave={onSave} onCancel={() => {}} />);
            const user = userEvent.setup({ delay: null });
            const inputs = screen.getAllByRole("textbox");
            await user.type(inputs[0] as HTMLElement, "plain");
            await user.type(inputs[1] as HTMLElement, "does things");

            await user.click(screen.getByRole("switch"));
            assert.equal(screen.getByRole("switch").getAttribute("aria-checked"), "true");
            await user.click(screen.getByText("agents.form.save"));

            assert.equal(onSave.mock.calls[0]?.[0].systemPrompt, "");
        });

        it("disables the textarea without discarding a draft", async () => {
            render(
                <AgentForm {...base} runtime="standard" onSave={() => {}} onCancel={() => {}} />,
            );
            const user = userEvent.setup({ delay: null });
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
                    {...base}
                    runtime="standard"
                    existing={{
                        scope: "global",
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

    describe("scope", () => {
        const scopeTrigger = () => screen.getByRole("combobox", { name: "agents.form.scope" });

        it("defaults to global and saves the scope it was given", async () => {
            const onSave = vi.fn<(v: AgentFormValue) => void>();
            render(<AgentForm {...base} runtime="standard" onSave={onSave} onCancel={() => {}} />);
            const user = await fillRequired("plain");
            await user.click(screen.getByText("agents.form.save"));
            assert.equal(onSave.mock.calls[0]?.[0].scope, "global");
        });

        it("saves a workspace scope picked in the dropdown", async () => {
            const onSave = vi.fn<(v: AgentFormValue) => void>();
            render(<AgentForm {...base} runtime="standard" onSave={onSave} onCancel={() => {}} />);
            const user = await fillRequired("plain");
            await user.click(scopeTrigger());
            await user.click(await screen.findByRole("option", { name: "agents.scope.workspace" }));
            await user.click(screen.getByText("agents.form.save"));
            assert.equal(onSave.mock.calls[0]?.[0].scope, "workspace");
        });

        it("disables the picker when there is no project directory", () => {
            render(
                <AgentForm
                    {...base}
                    hasProjectDir={false}
                    runtime="standard"
                    onSave={() => {}}
                    onCancel={() => {}}
                />,
            );
            assert.equal(scopeTrigger().hasAttribute("disabled"), true);
        });

        it("warns when a workspace agent would shadow a global one", async () => {
            render(
                <AgentForm
                    {...base}
                    shadowedTypes={["reviewer"]}
                    runtime="standard"
                    onSave={() => {}}
                    onCancel={() => {}}
                />,
            );
            const user = userEvent.setup({ delay: null });
            await user.type(screen.getAllByRole("textbox")[0] as HTMLElement, "reviewer");
            assert.equal(screen.queryByText("agents.form.shadowsGlobal"), null);

            await user.click(scopeTrigger());
            await user.click(await screen.findByRole("option", { name: "agents.scope.workspace" }));
            assert.ok(screen.getByText("agents.form.shadowsGlobal"));
        });
    });

    describe("Claude Code run directory", () => {
        const cwdTrigger = () => screen.getByRole("combobox", { name: "agents.form.ccCwd" });
        const ccExisting = (cwd?: string): AgentFormValue => ({
            scope: "global",
            agentType: "coder",
            description: "d",
            runtime: "claude-code",
            maxTurns: 30,
            systemPrompt: "p",
            ...(cwd !== undefined ? { cwd } : {}),
        });

        it("a new agent starts on the workspace directory and saves it", async () => {
            const onSave = vi.fn<(v: AgentFormValue) => void>();
            render(
                <AgentForm {...base} runtime="claude-code" onSave={onSave} onCancel={() => {}} />,
            );
            assert.match(cwdTrigger().textContent ?? "", /\/work\/repo/);
            const user = await fillRequired("coder");
            await user.click(screen.getByText("agents.form.save"));
            assert.equal(onSave.mock.calls[0]?.[0].cwd, "/work/repo");
        });

        it("shows the directory a saved agent is fixed to", () => {
            render(
                <AgentForm
                    {...base}
                    runtime="claude-code"
                    existing={ccExisting("/work/assoc")}
                    onSave={() => {}}
                    onCancel={() => {}}
                />,
            );
            assert.match(cwdTrigger().textContent ?? "", /\/work\/assoc/);
        });

        it("an agent saved without a directory shows the workspace and stores it on save", async () => {
            const onSave = vi.fn<(v: AgentFormValue) => void>();
            render(
                <AgentForm
                    {...base}
                    runtime="claude-code"
                    existing={ccExisting()}
                    onSave={onSave}
                    onCancel={() => {}}
                />,
            );
            assert.match(cwdTrigger().textContent ?? "", /\/work\/repo/);
            await userEvent.setup({ delay: null }).click(screen.getByText("agents.form.save"));
            assert.equal(onSave.mock.calls[0]?.[0].cwd, "/work/repo");
        });

        it("saves an associated directory picked from the list", async () => {
            const onSave = vi.fn<(v: AgentFormValue) => void>();
            render(
                <AgentForm {...base} runtime="claude-code" onSave={onSave} onCancel={() => {}} />,
            );
            const user = await fillRequired("coder");
            await user.click(cwdTrigger());
            await user.click(await screen.findByRole("option", { name: "/work/assoc" }));
            await user.click(screen.getByText("agents.form.save"));
            assert.equal(onSave.mock.calls[0]?.[0].cwd, "/work/assoc");
        });

        it("keeps a directory from another workspace instead of moving the agent", async () => {
            const onSave = vi.fn<(v: AgentFormValue) => void>();
            render(
                <AgentForm
                    {...base}
                    runtime="claude-code"
                    existing={ccExisting("/elsewhere/repo")}
                    onSave={onSave}
                    onCancel={() => {}}
                />,
            );
            assert.match(cwdTrigger().textContent ?? "", /\/elsewhere\/repo/);
            await userEvent.setup({ delay: null }).click(screen.getByText("agents.form.save"));
            assert.equal(onSave.mock.calls[0]?.[0].cwd, "/elsewhere/repo");
        });

        it("the taco dialog has no run directory and saves none", async () => {
            const onSave = vi.fn<(v: AgentFormValue) => void>();
            render(<AgentForm {...base} runtime="standard" onSave={onSave} onCancel={() => {}} />);
            assert.equal(screen.queryByRole("combobox", { name: "agents.form.ccCwd" }), null);
            const user = await fillRequired("plain");
            await user.click(screen.getByText("agents.form.save"));
            assert.equal("cwd" in (onSave.mock.calls[0]?.[0] ?? {}), false);
        });
    });

    it("Codex dialog: a missing npm shows the command instead of a dead install button", () => {
        render(
            <AgentForm
                {...base}
                runtime="codex"
                codexRuntimeStatus={{
                    runtime: "codex",
                    installed: false,
                    auth: "unknown",
                    installer: "missing",
                    installCommand: "npm install @openai/codex-sdk@0.167.2",
                }}
                onSave={() => {}}
                onCancel={() => {}}
            />,
        );
        assert.ok(screen.getByText("agents.form.codexNpmMissing"));
        assert.ok(screen.getByText("npm install @openai/codex-sdk@0.167.2"));
        assert.equal(screen.queryByText("agents.form.codexInstall"), null);
    });

    it("Codex dialog: does not claim the runtime is missing while status is still loading", () => {
        render(
            <AgentForm
                {...base}
                runtime="codex"
                codexStatusLoading
                onSave={() => {}}
                onCancel={() => {}}
            />,
        );
        assert.ok(screen.getByText("agents.form.codexChecking"));
        assert.equal(screen.queryByText("agents.form.codexInstall"), null);
    });

    it("Codex dialog: an empty model inherits the user's Codex configuration", async () => {
        const onSave = vi.fn<(v: AgentFormValue) => void>();
        render(
            <AgentForm
                {...base}
                runtime="codex"
                codexRuntimeStatus={{
                    runtime: "codex",
                    installed: true,
                    version: "0.167.2",
                    auth: "signed-in",
                    model: "MiniMax-M3",
                    provider: "custom",
                }}
                onSave={onSave}
                onCancel={() => {}}
            />,
        );
        const user = await fillRequired("codex-inherits");
        await user.click(screen.getByText("agents.form.save"));
        const saved = onSave.mock.calls[0]?.[0];
        assert.ok(saved);
        assert.equal(
            "model" in (saved.codex ?? {}),
            false,
            "no model override means the user's Codex config decides",
        );
        assert.ok(screen.getByText("agents.form.codexUsesConfig"));
    });

    it("Codex dialog: engine settings live in a titled section with a two-column grid", () => {
        render(
            <AgentForm
                {...base}
                runtime="codex"
                codexRuntimeStatus={{
                    runtime: "codex",
                    installed: true,
                    version: "0.167.2",
                    auth: "signed-in",
                }}
                onSave={() => {}}
                onCancel={() => {}}
            />,
        );
        assert.ok(screen.getByText("agents.form.codexEngineTitle"));
        assert.ok(screen.getByText("agents.form.codexEngineHint"));
        const grid = document.querySelector(".agent-form-grid");
        assert.ok(grid, "the engine fields must sit in the grid");
        // The run directory and the approval policy each need a full row.
        assert.equal(
            document.querySelectorAll(".agent-form-grid > .agent-form-grid-full").length,
            2,
        );
        assert.ok(screen.getByText("agents.form.codexSandboxHint"));
        assert.ok(screen.getByText("agents.form.codexApprovalHint"));
    });

    it("Codex dialog: the setup card shows a status chip, not a bare sentence", () => {
        render(
            <AgentForm
                {...base}
                runtime="codex"
                codexRuntimeStatus={{
                    runtime: "codex",
                    installed: true,
                    version: "0.167.2",
                    auth: "signed-out",
                    loginCommand: "node codex.js login",
                }}
                onSave={() => {}}
                onCancel={() => {}}
            />,
        );
        assert.ok(screen.getByText("agents.form.codexSetupTitle"));
        assert.ok(screen.getByText("agents.form.codexChipSignedOut"));
        assert.ok(screen.getByText("node codex.js login"));
    });
});
