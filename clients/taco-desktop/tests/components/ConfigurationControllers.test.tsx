import type { ToolEntry } from "@taco-ai/protocol";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigurationSkillsController } from "../../src/components/configuration/ConfigurationSkillsController";
import { ConfigurationToolsController } from "../../src/components/configuration/ConfigurationToolsController";
import type { TacoClient } from "../../src/lib/clients/tacoClient";
import type { SkillsPaneProps } from "../../src/views/SkillsPane";
import { queryWrapper } from "../helpers/queryWrapper";

vi.mock("../../src/i18n/useI18n", () => ({
    useT: () => ({ t: (key: string) => key }),
}));

vi.mock("../../src/components/ConfigurationScopeBar", () => ({
    ConfigurationScopeBar: ({
        targetCwd,
        targetOptions,
        onTargetChange,
    }: {
        targetCwd: string | undefined;
        targetOptions: readonly { value: string }[];
        onTargetChange: (cwd: string) => void;
    }) => (
        <div data-testid="scope" data-target={targetCwd}>
            {targetOptions.map((option) => (
                <button
                    key={option.value}
                    type="button"
                    onClick={() => onTargetChange(option.value)}
                >
                    target:{option.value}
                </button>
            ))}
        </div>
    ),
}));

vi.mock("../../src/views/SkillsPane", () => ({
    SkillsPane: (props: SkillsPaneProps) => (
        <div data-testid="skills-view">
            <input
                aria-label="skill-search"
                value={props.query}
                onChange={(event) => props.onQueryChange(event.target.value)}
            />
            <span data-testid="selected-skill">{props.selectedName}</span>
            {props.skills.map((skill) => (
                <button key={skill.name} type="button" onClick={() => props.onSelect(skill.name)}>
                    {skill.name}
                </button>
            ))}
        </div>
    ),
}));

afterEach(cleanup);

const tools: ToolEntry[] = [
    {
        name: "read_file",
        label: "Read file",
        description: "Read a workspace file.",
        category: "builtin",
        inputSchema: { type: "object" },
    },
    {
        name: "web_search",
        label: "Web search",
        description: "Search the web.",
        category: "mcp",
    },
];

function makeClient() {
    let finishSave = () => {};
    const agentsWrite = vi.fn(
        () =>
            new Promise<{ ok: true }>((resolve) => {
                finishSave = () => resolve({ ok: true });
            }),
    );
    const client = {
        agentsList: vi.fn(async ({ workspace }: { workspace: string }) => ({
            agents: ["demo", "other"].map((agentType) => ({
                agentType,
                description: `${workspace}:${agentType}`,
                runtime: "standard",
                source: "user",
                scope: "workspace",
                editable: true,
            })),
            cwdChoices: [workspace],
        })),
        agentsContent: vi.fn(async ({ workspace, agentType }) => ({
            agentType,
            description: `${workspace}:${agentType}`,
            runtime: "standard",
            source: "user",
            scope: "workspace",
            editable: true,
            maxTurns: 5,
            systemPrompt: `${workspace}:${agentType}`,
        })),
        agentsRuntimeStatus: vi.fn(async () => ({
            runtime: "codex",
            installed: true,
            auth: "signed-in",
        })),
        agentsWrite,
        agentsDelete: vi.fn(async () => ({ ok: true })),
        agentsInstallRuntime: vi.fn(async () => ({ ok: true })),
        skillsList: vi.fn(async () => ({
            skills: [
                { name: "alpha", description: "Alpha", filePath: "/alpha.md" },
                { name: "beta", description: "Beta", filePath: "/beta.md" },
            ],
            diagnostics: [],
        })),
        skillContent: vi.fn(async () => ({ content: "Instructions" })),
        toolsList: vi.fn(async () => ({ tools })),
    } as unknown as TacoClient;
    return { client, agentsWrite, finishSave: () => finishSave() };
}

function props(client: TacoClient, active = true) {
    return {
        active,
        client,
        mode: "workspace" as const,
        activeCwd: "/repo-a",
        workspaces: { "/repo-a": {}, "/repo-b": {} },
        conversations: [],
        conversationsLoading: false,
        conversationsError: null,
        onRetryTargets: vi.fn(),
    };
}

describe("configuration page controllers", () => {
    it("keeps skill search across page and target round trips but resets selection on a new target", async () => {
        const fixture = makeClient();
        const view = render(<ConfigurationSkillsController {...props(fixture.client)} />, {
            ...queryWrapper(),
        });
        await screen.findByRole("button", { name: "beta" });
        fireEvent.click(screen.getByRole("button", { name: "beta" }));
        expect(screen.getByTestId("selected-skill").textContent).toBe("beta");
        fireEvent.change(screen.getByLabelText("skill-search"), { target: { value: "beta" } });

        view.rerender(<ConfigurationSkillsController {...props(fixture.client, false)} />);
        expect(screen.queryByTestId("skills-view")).toBeNull();
        view.rerender(<ConfigurationSkillsController {...props(fixture.client)} />);
        expect(screen.getByLabelText("skill-search")).toHaveProperty("value", "beta");

        fireEvent.click(screen.getByRole("button", { name: "target:/repo-b" }));
        await waitFor(() =>
            expect(screen.getByTestId("scope").getAttribute("data-target")).toBe("/repo-b"),
        );
        expect(screen.getByLabelText("skill-search")).toHaveProperty("value", "beta");
        fireEvent.change(screen.getByLabelText("skill-search"), { target: { value: "" } });
        await screen.findByRole("button", { name: "alpha" });
        expect(screen.getByTestId("selected-skill").textContent).toBe("alpha");

        fireEvent.click(screen.getByRole("button", { name: "target:/repo-a" }));
        await waitFor(() =>
            expect(screen.getByTestId("scope").getAttribute("data-target")).toBe("/repo-a"),
        );
        expect(screen.getByLabelText("skill-search")).toHaveProperty("value", "");
    });

    it("keeps tools view state on target changes and resets it after leaving the page", async () => {
        const fixture = makeClient();
        const view = render(<ConfigurationToolsController {...props(fixture.client)} />, {
            ...queryWrapper(),
        });
        await screen.findByRole("button", { name: /Web search/ });
        fireEvent.click(screen.getByRole("button", { name: /Web search/ }));
        expect(screen.getByRole("heading", { name: "web_search" })).toBeTruthy();

        fireEvent.click(screen.getByRole("button", { name: "target:/repo-b" }));
        await waitFor(() =>
            expect(screen.getByTestId("scope").getAttribute("data-target")).toBe("/repo-b"),
        );
        await screen.findByRole("heading", { name: "web_search" });

        view.rerender(
            <ConfigurationToolsController {...props(fixture.client, false)} activeCwd="/repo-b" />,
        );
        expect(screen.queryByRole("heading", { name: "web_search" })).toBeNull();
        view.rerender(
            <ConfigurationToolsController {...props(fixture.client)} activeCwd="/repo-b" />,
        );
        await screen.findByRole("heading", { name: "read_file" });
        expect(screen.queryByRole("heading", { name: "web_search" })).toBeNull();
    });
});
