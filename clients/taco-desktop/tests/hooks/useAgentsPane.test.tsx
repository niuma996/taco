import {
    type AgentEntry,
    type AgentsContentParams,
    type AgentsContentResult,
    type AgentsListParams,
    type AgentsListResult,
    type AgentsRuntimeStatusResult,
    asWorkspaceId,
} from "@taco-ai/protocol";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AgentSaveInput, useAgentsPane } from "../../src/hooks/useAgentsPane";
import type { TacoClient } from "../../src/lib/clients/tacoClient";
import type { ConfigurationScope } from "../../src/lib/configurationScope";
import { resourceQueryKey } from "../../src/lib/queries/queryClient";
import { queryWrapper } from "../helpers/queryWrapper";

afterEach(cleanup);

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
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

function makeClient() {
    const agentsList = vi.fn(async (params: AgentsListParams) => catalog(params));
    const agentsWrite = vi.fn(async () => ({ ok: true as const }));
    const agentsDelete = vi.fn(async () => ({ ok: true as const }));
    const agentsRuntimeStatus = vi.fn(
        async (): Promise<AgentsRuntimeStatusResult> => ({
            runtime: "codex",
            installed: false,
            auth: "unknown",
        }),
    );
    const agentsInstallRuntime = vi.fn(async () => ({ ok: true as const }));
    const agentsContent = vi.fn(
        async (params: AgentsContentParams): Promise<AgentsContentResult> => ({
            ...catalog(params).agents[0],
            agentType: params.agentType,
            systemPrompt: `${params.workspace}:${params.scope}:${params.agentType}`,
            maxTurns: 5,
        }),
    );
    const client = {
        agentsList,
        agentsWrite,
        agentsDelete,
        agentsContent,
        agentsRuntimeStatus,
        agentsInstallRuntime,
    } as unknown as TacoClient;
    return {
        client,
        agentsList,
        agentsWrite,
        agentsDelete,
        agentsContent,
        agentsRuntimeStatus,
        agentsInstallRuntime,
    };
}

function setup(fixture = makeClient(), options = queryWrapper()) {
    const { client } = fixture;
    const view = renderHook(
        ({ cwd, scope }: { cwd: string; scope: ConfigurationScope }) =>
            useAgentsPane(client, true, cwd, scope),
        { ...options, initialProps: { cwd: "/repo-a", scope: "workspace" as ConfigurationScope } },
    );
    return { ...view, ...fixture, ...options };
}

async function loaded(
    h: ReturnType<typeof setup>,
    cwd = "/repo-a",
    scope = "workspace",
    type = "demo",
) {
    await waitFor(() =>
        expect(h.result.current.agentContent?.systemPrompt).toBe(`${cwd}:${scope}:${type}`),
    );
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
                await loaded(h);
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
                await loaded(h, transition.cwd, transition.scope);
                if (transition.roundTrip) {
                    h.rerender({ cwd: "/repo-a", scope: "workspace" });
                    await loaded(h);
                }
                await act(async () => {
                    h.result.current.setSelectedAgentType("other");
                });
                await loaded(
                    h,
                    transition.roundTrip ? "/repo-a" : transition.cwd,
                    transition.roundTrip ? "workspace" : transition.scope,
                    "other",
                );
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
            await loaded(h);
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
            await loaded(h, "/repo-b");
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
            await waitFor(() =>
                expect(h.result.current.agents[0]?.description).toBe("/repo-b:workspace:demo"),
            );
        });
    }

    for (const transition of transitions.filter((value) => !value.roundTrip)) {
        it(`does not select a saved agent after its reload spans a ${transition.name} change`, async () => {
            const h = setup();
            await loaded(h);
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
            await loaded(h, transition.cwd, transition.scope, "other");
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
        await loaded(h);
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
        await loaded(h);
        h.agentsList.mockResolvedValueOnce({ agents: [], cwdChoices: ["/repo-a"] });
        await act(async () => {
            await h.result.current.deleteAgent("demo", "workspace");
        });
        await waitFor(() => expect(h.result.current.agents).toEqual([]));
        expect(h.result.current.selectedAgentType).toBeNull();
        expect(h.result.current.agentContent).toBeNull();
        expect(h.result.current.agentSaving).toBe(false);
    });
});

describe("useAgentsPane read queries", () => {
    it("shares catalog, global list, content and runtime reads and refreshes between readers", async () => {
        const fixture = makeClient();
        const options = queryWrapper();
        const pendingContent = deferred<AgentsContentResult>();
        fixture.agentsContent.mockReturnValueOnce(pendingContent.promise);
        const one = setup(fixture, options);
        const two = setup(fixture, options);
        await waitFor(() => {
            expect(one.result.current.agentContentLoading).toBe(true);
            expect(two.result.current.agentContentLoading).toBe(true);
        });
        await act(async () =>
            pendingContent.resolve({
                ...catalog({ workspace: asWorkspaceId("/repo-a"), scope: "workspace" }).agents[0],
                systemPrompt: "/repo-a:workspace:demo",
            }),
        );
        await loaded(two);
        await loaded(one);
        expect(fixture.agentsList).toHaveBeenCalledTimes(2);
        expect(fixture.agentsContent).toHaveBeenCalledTimes(1);
        expect(fixture.agentsRuntimeStatus).toHaveBeenCalledTimes(1);
        const original = one.result.current.agentContent;
        if (!original) throw new Error("missing content");
        fixture.agentsContent.mockResolvedValue({ ...original, systemPrompt: "saved" });
        fixture.agentsRuntimeStatus.mockResolvedValue({
            runtime: "codex",
            installed: true,
            auth: "signed-in",
        });
        await act(async () => {
            await one.result.current.saveAgent(input, "demo", "workspace");
            await one.result.current.refreshCodexRuntime();
        });
        await waitFor(() => expect(two.result.current.agentContent?.systemPrompt).toBe("saved"));
        await waitFor(() => expect(two.result.current.codexRuntimeStatus?.installed).toBe(true));
        expect(one.result.current.agentContent?.systemPrompt).toBe("saved");
        expect(fixture.agentsList).toHaveBeenCalledTimes(4);
    });

    it("refreshes content after saving the same selected type with an unchanged catalog", async () => {
        const h = setup();
        await loaded(h);
        const original = h.result.current.agentContent;
        if (!original) throw new Error("missing content");
        h.agentsList.mockResolvedValue(
            catalog({ workspace: asWorkspaceId("/repo-a"), scope: "workspace" }),
        );
        h.agentsContent.mockResolvedValue({ ...original, systemPrompt: "updated prompt" });
        await act(async () => {
            await h.result.current.saveAgent(input);
        });
        await waitFor(() =>
            expect(h.result.current.agentContent?.systemPrompt).toBe("updated prompt"),
        );
    });

    for (const transition of transitions.filter((value) => !value.roundTrip)) {
        it(`isolates a late list response after a ${transition.name} change`, async () => {
            const fixture = makeClient();
            const pending = deferred<AgentsListResult>();
            fixture.agentsList.mockReturnValueOnce(pending.promise);
            const h = setup(fixture);
            h.rerender({ cwd: transition.cwd, scope: transition.scope });
            await loaded(h, transition.cwd, transition.scope);
            await act(async () => pending.resolve({ agents: [], cwdChoices: ["stale"] }));
            expect(h.result.current.agents[0]?.description).toBe(
                `${transition.cwd}:${transition.scope}:demo`,
            );
            expect(h.result.current.cwdChoices).toEqual([
                transition.cwd,
                `${transition.cwd}/associated`,
            ]);
            expect(
                h.queryClient.getQueryState(
                    resourceQueryKey(h.client, "agents", "/repo-a", "workspace"),
                )?.data,
            ).toBeUndefined();
        });

        it(`isolates a late content error after a ${transition.name} change`, async () => {
            const fixture = makeClient();
            const pending = deferred<AgentsContentResult>();
            fixture.agentsContent.mockReturnValueOnce(pending.promise);
            const h = setup(fixture);
            await waitFor(() => expect(h.result.current.agentContentLoading).toBe(true));
            h.rerender({ cwd: transition.cwd, scope: transition.scope });
            await loaded(h, transition.cwd, transition.scope);
            await act(async () => pending.reject(new Error("old content failed")));
            expect(h.result.current.agentContentError).toBeNull();
            expect(h.result.current.agentContent?.systemPrompt).toBe(
                `${transition.cwd}:${transition.scope}:demo`,
            );
        });
    }

    it("isolates clients using the same cache", async () => {
        const options = queryWrapper();
        const one = setup(makeClient(), options);
        const fixture = makeClient();
        fixture.agentsList.mockImplementation(async (params) => ({
            ...catalog(params),
            cwdChoices: ["second client"],
        }));
        const two = setup(fixture, options);
        await loaded(one);
        await loaded(two);
        expect(one.result.current.cwdChoices[0]).toBe("/repo-a");
        expect(two.result.current.cwdChoices).toEqual(["second client"]);
    });

    for (const operation of operations) {
        it(`invalidates inactive caches after a hidden ${operation} without refetching the new target`, async () => {
            const h = setup();
            await loaded(h);
            const pending = deferred<{ ok: true }>();
            (operation === "save" ? h.agentsWrite : h.agentsDelete).mockReturnValueOnce(
                pending.promise,
            );
            let mutation!: Promise<void>;
            act(() => {
                mutation =
                    operation === "save"
                        ? h.result.current.saveAgent(input)
                        : h.result.current.deleteAgent("demo", "workspace");
            });
            h.rerender({ cwd: "/repo-b", scope: "workspace" });
            await loaded(h, "/repo-b");
            const count = h.agentsList.mock.calls.length;
            await act(async () => {
                pending.resolve({ ok: true });
                await mutation;
            });
            expect(h.agentsList).toHaveBeenCalledTimes(count);
            expect(
                h.queryClient.getQueryState(
                    resourceQueryKey(h.client, "agents", "/repo-a", "workspace"),
                )?.isInvalidated,
            ).toBe(true);
            const content = h.queryClient.getQueryCache().findAll({
                queryKey: resourceQueryKey(
                    h.client,
                    "agent-content",
                    "/repo-a",
                    "workspace",
                    "demo",
                ),
            });
            expect(content).toHaveLength(1);
            expect(content[0].state.isInvalidated).toBe(true);
            h.rerender({ cwd: "/repo-a", scope: "workspace" });
            await loaded(h);
            await waitFor(() => expect(h.agentsList).toHaveBeenCalledTimes(count + 2));
        });
    }

    it("invalidates global and effective scopes across workspaces on a global move", async () => {
        const h = setup();
        await loaded(h);
        h.rerender({ cwd: "/repo-b", scope: "effective" });
        await loaded(h, "/repo-b");
        h.rerender({ cwd: "/repo-b", scope: "global" });
        await loaded(h, "/repo-b", "global");
        h.rerender({ cwd: "/repo-b", scope: "workspace" });
        await loaded(h, "/repo-b");
        h.rerender({ cwd: "/repo-a", scope: "workspace" });
        await loaded(h);
        await act(async () => {
            await h.result.current.saveAgent(input, "demo", "global");
        });
        for (const scope of ["global", "effective"]) {
            expect(
                h.queryClient.getQueryState(resourceQueryKey(h.client, "agents", "/repo-b", scope))
                    ?.isInvalidated,
            ).toBe(true);
        }
        expect(
            h.queryClient.getQueryState(
                resourceQueryKey(h.client, "agents", "/repo-b", "workspace"),
            )?.isInvalidated,
        ).toBe(false);
        const globalContent = h.queryClient.getQueryCache().findAll({
            queryKey: resourceQueryKey(h.client, "agent-content", "/repo-b", "global", "demo"),
        });
        expect(globalContent).toHaveLength(1);
        expect(globalContent[0].state.isInvalidated).toBe(true);
    });

    it("does not read a disabled pane or subscribe to connection readiness", async () => {
        const fixture = makeClient();
        const onConnectionReady = vi.fn();
        Object.assign(fixture.client, { onConnectionReady });
        const view = renderHook(({ active, cwd }) => useAgentsPane(fixture.client, active, cwd), {
            ...queryWrapper(),
            initialProps: { active: false, cwd: "/repo-a" as string | undefined },
        });
        expect(fixture.agentsList).not.toHaveBeenCalled();
        expect(fixture.agentsContent).not.toHaveBeenCalled();
        expect(fixture.agentsRuntimeStatus).not.toHaveBeenCalled();
        view.rerender({ active: true, cwd: undefined });
        await waitFor(() => expect(view.result.current.codexRuntimeStatus?.runtime).toBe("codex"));
        expect(fixture.agentsList).not.toHaveBeenCalled();
        expect(onConnectionReady).not.toHaveBeenCalled();
    });
});

describe("useAgentsPane refresh and write failures", () => {
    it("cancels a pending initial runtime read when installation succeeds", async () => {
        const fixture = makeClient();
        const pending = deferred<AgentsRuntimeStatusResult>();
        fixture.agentsRuntimeStatus.mockReturnValueOnce(pending.promise).mockResolvedValue({
            runtime: "codex",
            installed: true,
            auth: "signed-in",
        });
        const h = setup(fixture);
        await loaded(h);
        await act(async () => {
            await h.result.current.installCodexRuntime();
        });
        await act(async () =>
            pending.resolve({ runtime: "codex", installed: false, auth: "unknown" }),
        );
        await waitFor(() => expect(h.result.current.codexRuntimeStatus?.installed).toBe(true));
        expect(h.agentsRuntimeStatus).toHaveBeenCalledTimes(2);
        expect(h.result.current.codexInstalling).toBe(false);
    });

    it("replaces a pending initial runtime read on manual refresh", async () => {
        const fixture = makeClient();
        const pending = deferred<AgentsRuntimeStatusResult>();
        fixture.agentsRuntimeStatus.mockReturnValueOnce(pending.promise).mockResolvedValue({
            runtime: "codex",
            installed: true,
            auth: "signed-in",
        });
        const h = setup(fixture);
        await loaded(h);
        let refresh!: Promise<void>;
        act(() => {
            refresh = h.result.current.refreshCodexRuntime();
        });
        await act(async () =>
            pending.resolve({ runtime: "codex", installed: false, auth: "unknown" }),
        );
        await act(async () => {
            await refresh;
        });
        await waitFor(() => expect(h.result.current.codexRuntimeStatus?.installed).toBe(true));
    });

    for (const operation of operations) {
        it(`does not retry a failed ${operation} or refetch, and preserves the new target's error`, async () => {
            const h = setup();
            await loaded(h);
            const pending = deferred<{ ok: true }>();
            const mutate = operation === "save" ? h.agentsWrite : h.agentsDelete;
            mutate.mockReturnValueOnce(pending.promise);
            let failed!: Promise<unknown>;
            act(() => {
                failed = (
                    operation === "save"
                        ? h.result.current.saveAgent(input)
                        : h.result.current.deleteAgent("demo", "workspace")
                ).catch((error: unknown) => error);
            });
            h.agentsContent.mockRejectedValueOnce(new Error("current content failed"));
            h.rerender({ cwd: "/repo-b", scope: "workspace" });
            await waitFor(() =>
                expect(h.result.current.agentContentError).toBe("current content failed"),
            );
            const readCount = h.agentsList.mock.calls.length;
            await act(async () => {
                pending.reject(new Error("old write failed"));
                await failed;
            });
            expect(h.result.current.agentContentError).toBe("current content failed");
            expect(h.result.current.agentSaving).toBe(false);
            expect(h.agentsList).toHaveBeenCalledTimes(readCount);
            expect(mutate).toHaveBeenCalledTimes(1);
        });
    }

    it("keeps a hidden global write from refetching the current workspace's effective pane", async () => {
        const h = setup();
        h.rerender({ cwd: "/repo-a", scope: "global" });
        await loaded(h, "/repo-a", "global");
        const pending = deferred<{ ok: true }>();
        h.agentsWrite.mockReturnValueOnce(pending.promise);
        let saving!: Promise<void>;
        act(() => {
            saving = h.result.current.saveAgent({ ...input, scope: "global" });
        });
        h.rerender({ cwd: "/repo-b", scope: "effective" });
        await loaded(h, "/repo-b");
        const readCount = h.agentsList.mock.calls.length;
        await act(async () => {
            pending.resolve({ ok: true });
            await saving;
        });
        expect(h.agentsList).toHaveBeenCalledTimes(readCount);
        expect(h.result.current.agentContent?.systemPrompt).toBe("/repo-b:workspace:demo");
        expect(
            h.queryClient.getQueryState(
                resourceQueryKey(h.client, "agents", "/repo-b", "effective"),
            )?.isInvalidated,
        ).toBe(true);
    });
});
