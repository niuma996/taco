import type {
    AgentEntry,
    AgentsContentParams,
    AgentsContentResult,
    AgentsListParams,
    AgentsListResult,
} from "@taco-ai/protocol";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AgentSaveInput, useAgentsPane } from "../../src/hooks/useAgentsPane";
import type { TacoClient } from "../../src/lib/clients/tacoClient";
import type { ConfigurationScope } from "../../src/lib/configurationScope";

afterEach(cleanup);

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((yes) => {
        resolve = yes;
    });
    return { promise, resolve };
}

const input: AgentSaveInput = {
    scope: "workspace",
    agentType: "demo",
    description: "Edited agent",
    runtime: "standard",
    maxTurns: 5,
    systemPrompt: "Edited prompt",
};

function catalog({ workspace, scope }: AgentsListParams): AgentsListResult {
    const agents: AgentEntry[] = ["demo", "other"].map((agentType) => ({
        agentType,
        description: `${workspace}:${scope ?? "effective"}:${agentType}`,
        runtime: "standard",
        source: "user",
        scope: scope === "global" ? "global" : "workspace",
        editable: true,
    }));
    return { agents, cwdChoices: [workspace, `${workspace}/associated`] };
}

function setup() {
    const agentsList = vi.fn(async (params: AgentsListParams) => catalog(params));
    const agentsWrite = vi.fn(async () => ({ ok: true as const }));
    const agentsDelete = vi.fn(async () => ({ ok: true as const }));
    const client = {
        agentsList,
        agentsWrite,
        agentsDelete,
        agentsContent: vi.fn(async (params: AgentsContentParams): Promise<AgentsContentResult> => {
            const selected = catalog(params).agents.find(
                (agent) => agent.agentType === params.agentType,
            );
            if (!selected) throw new Error(`agent not found: ${params.agentType}`);
            return {
                ...selected,
                systemPrompt: `${params.workspace}:${params.scope}:${params.agentType}`,
                maxTurns: 5,
            };
        }),
    } as unknown as TacoClient;
    const view = renderHook(
        ({ cwd, scope }: { cwd: string; scope: ConfigurationScope }) =>
            useAgentsPane(client, true, cwd, scope),
        { initialProps: { cwd: "/repo-a", scope: "workspace" as ConfigurationScope } },
    );
    return { ...view, agentsList, agentsWrite, agentsDelete };
}

const operations = ["save", "delete"] as const;
const transitions = [
    { name: "target", cwd: "/repo-b", scope: "workspace", roundTrip: false },
    { name: "scope", cwd: "/repo-a", scope: "global", roundTrip: false },
    { name: "target round trip", cwd: "/repo-b", scope: "workspace", roundTrip: true },
    { name: "scope round trip", cwd: "/repo-a", scope: "global", roundTrip: true },
] satisfies { name: string; cwd: string; scope: ConfigurationScope; roundTrip: boolean }[];

describe("useAgentsPane mutation generations", () => {
    for (const operation of operations) {
        for (const transition of transitions) {
            it(`ignores an old ${operation} completion after a ${transition.name} change`, async () => {
                const h = setup();
                await act(async () => {});
                const pending = deferred<{ ok: true }>();
                const mutate = operation === "save" ? h.agentsWrite : h.agentsDelete;
                mutate.mockReturnValueOnce(pending.promise);
                let mutation!: Promise<void>;
                act(() => {
                    mutation =
                        operation === "save"
                            ? h.result.current.saveAgent(input, "demo", "workspace")
                            : h.result.current.deleteAgent("demo", "workspace");
                });
                h.rerender({ cwd: transition.cwd, scope: transition.scope });
                await act(async () => {});
                if (transition.roundTrip) {
                    h.rerender({ cwd: "/repo-a", scope: "workspace" });
                    await act(async () => {});
                }
                await act(async () => {
                    h.result.current.setSelectedAgentType("other");
                });
                const before = h.result.current;
                const readCount = h.agentsList.mock.calls.length;
                await act(async () => {
                    pending.resolve({ ok: true });
                    await mutation;
                });
                expect(h.result.current.agents).toEqual(before.agents);
                expect(h.result.current.globalAgentTypes).toEqual(before.globalAgentTypes);
                expect(h.result.current.cwdChoices).toEqual(before.cwdChoices);
                expect(h.result.current.selectedAgentType).toBe("other");
                expect(h.result.current.agentContent).toEqual(before.agentContent);
                expect(h.agentsList).toHaveBeenCalledTimes(readCount);
            });
        }

        it(`keeps a new target's ${operation} busy when an old mutation completes`, async () => {
            const h = setup();
            await act(async () => {});
            const old = deferred<{ ok: true }>();
            const current = deferred<{ ok: true }>();
            const mutate = operation === "save" ? h.agentsWrite : h.agentsDelete;
            mutate.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
            const run = () =>
                operation === "save"
                    ? h.result.current.saveAgent(input, "demo", "workspace")
                    : h.result.current.deleteAgent("demo", "workspace");
            let oldMutation!: Promise<void>;
            act(() => {
                oldMutation = run();
            });
            expect(h.result.current.agentSaving).toBe(true);
            h.rerender({ cwd: "/repo-b", scope: "workspace" });
            await act(async () => {});
            expect(h.result.current.agentSaving).toBe(false);
            let currentMutation!: Promise<void>;
            act(() => {
                currentMutation = run();
            });
            await act(async () => {
                old.resolve({ ok: true });
                await oldMutation;
            });
            expect(h.result.current.agentSaving).toBe(true);
            await act(async () => {
                current.resolve({ ok: true });
                await currentMutation;
            });
            expect(h.result.current.agentSaving).toBe(false);
            expect(h.result.current.agents[0]?.description).toBe("/repo-b:workspace:demo");
        });
    }

    for (const transition of transitions.filter((value) => !value.roundTrip)) {
        it(`does not select a saved agent after its reload spans a ${transition.name} change`, async () => {
            const h = setup();
            await act(async () => {});
            const reloading = deferred<AgentsListResult>();
            h.agentsList.mockReturnValueOnce(reloading.promise);
            let saving!: Promise<void>;
            await act(async () => {
                saving = h.result.current.saveAgent(input, "demo", "workspace");
            });
            h.rerender({ cwd: transition.cwd, scope: transition.scope });
            await act(async () => {
                h.result.current.setSelectedAgentType("other");
            });
            const before = h.result.current.agents;
            await act(async () => {
                reloading.resolve({ agents: [], cwdChoices: ["/repo-a"] });
                await saving;
            });
            expect(h.result.current.agents).toEqual(before);
            expect(h.result.current.selectedAgentType).toBe("other");
        });
    }

    it("reloads and selects the saved agent when the target and scope stay current", async () => {
        const h = setup();
        await act(async () => {});
        await act(async () => {
            h.result.current.setSelectedAgentType("other");
        });
        const readCount = h.agentsList.mock.calls.length;
        await act(async () => {
            await h.result.current.saveAgent(input, "demo", "workspace");
        });
        expect(h.agentsList).toHaveBeenCalledTimes(readCount + 2);
        expect(h.result.current.selectedAgentType).toBe("demo");
        expect(h.result.current.agentSaving).toBe(false);
    });

    it("reloads the catalog after deleting from the current target and scope", async () => {
        const h = setup();
        await act(async () => {});
        h.agentsList.mockResolvedValueOnce({ agents: [], cwdChoices: ["/repo-a"] });
        await act(async () => {
            await h.result.current.deleteAgent("demo", "workspace");
        });
        expect(h.result.current.agents).toEqual([]);
        expect(h.result.current.selectedAgentType).toBeNull();
        expect(h.result.current.agentContent).toBeNull();
        expect(h.result.current.agentSaving).toBe(false);
    });
});
