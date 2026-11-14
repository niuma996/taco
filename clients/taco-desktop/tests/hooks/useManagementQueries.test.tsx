import type { ExtensionsStatusResult, SkillEntry, SkillsListParams } from "@taco-ai/protocol";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePluginsPane } from "../../src/hooks/usePluginsPane";
import { useSkillsPane } from "../../src/hooks/useSkillsPane";
import { useToolsPane } from "../../src/hooks/useToolsPane";
import type { TacoClient } from "../../src/lib/clients/tacoClient";
import { applyGlobalConfig } from "../../src/lib/globalConfig";
import { resourceQueryKey } from "../../src/lib/queries/queryClient";
import { queryWrapper } from "../helpers/queryWrapper";

afterEach(cleanup);
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((yes) => {
        resolve = yes;
    });
    return { promise, resolve };
}
const skill = (workspace: string, scope = "global"): SkillEntry => ({
    name: "demo",
    description: `${workspace}:${scope}`,
    filePath: `${workspace}/${scope}/SKILL.md`,
    source: "user",
    scope: scope as SkillEntry["scope"],
});

describe("management queries", () => {
    it("deduplicates the same tool catalog for two readers", async () => {
        const toolsList = vi.fn(async () => ({ tools: [] }));
        const client = { toolsList } as unknown as TacoClient;
        const options = queryWrapper();
        renderHook(() => useToolsPane(client, true, "/a"), options);
        renderHook(() => useToolsPane(client, true, "/a"), options);
        await waitFor(() => expect(toolsList).toHaveBeenCalled());
        expect(toolsList).toHaveBeenCalledTimes(1);
    });

    it("deduplicates skills list and selected content across readers", async () => {
        const skillsList = vi.fn(async () => ({ skills: [skill("/a")], diagnostics: [] }));
        const skillContent = vi.fn(async () => ({ content: "instructions" }));
        const client = { skillsList, skillContent } as unknown as TacoClient;
        const options = queryWrapper();
        const one = renderHook(() => useSkillsPane(client, true, "/a", "global"), options);
        const two = renderHook(() => useSkillsPane(client, true, "/a", "global"), options);
        await waitFor(() => expect(two.result.current.skillContent).toBe("instructions"));
        expect(one.result.current.skillContent).toBe("instructions");
        expect(skillsList).toHaveBeenCalledTimes(1);
        expect(skillContent).toHaveBeenCalledTimes(1);
    });

    it("isolates scope and file identity when a previous skill detail arrives late", async () => {
        const pending = deferred<{ content: string }>();
        const skillsList = vi.fn(async (params: SkillsListParams) => ({
            skills: [skill(params.workspace, params.scope)],
            diagnostics: [],
        }));
        const skillContent = vi
            .fn()
            .mockReturnValueOnce(pending.promise)
            .mockResolvedValue({ content: "workspace content" });
        const client = { skillsList, skillContent } as unknown as TacoClient;
        const view = renderHook(
            ({ scope }: { scope: "global" | "workspace" }) =>
                useSkillsPane(client, true, "/a", scope),
            {
                ...queryWrapper(),
                initialProps: { scope: "global" },
            },
        );
        await waitFor(() => expect(skillContent).toHaveBeenCalledTimes(1));
        view.rerender({ scope: "workspace" });
        await waitFor(() => expect(view.result.current.skillContent).toBe("workspace content"));
        await act(async () => pending.resolve({ content: "old global content" }));
        expect(view.result.current.skillContent).toBe("workspace content");
        expect(skillContent).toHaveBeenLastCalledWith({
            workspace: "/a",
            scope: "workspace",
            filePath: "/a/workspace/SKILL.md",
        });
    });

    it("shares process-wide plugin status across workspace readers", async () => {
        const status: ExtensionsStatusResult = {
            loaded: [],
            disabled: [],
            failed: [],
            unauthorized: [],
        };
        const extensionsStatus = vi.fn(async () => status);
        const client = { extensionsStatus } as unknown as TacoClient;
        const options = queryWrapper();
        renderHook(() => usePluginsPane(client, true, "/a", async () => {}), options);
        const two = renderHook(() => usePluginsPane(client, true, "/b", async () => {}), options);
        await waitFor(() => expect(two.result.current.extensionStatus).toEqual(status));
        expect(extensionsStatus).toHaveBeenCalledTimes(1);
    });
    it("plugin changes update all readers and a restart reloads the shared cache", async () => {
        applyGlobalConfig({ disabledExtensions: [] });
        const initial: ExtensionsStatusResult = {
            loaded: [],
            disabled: [],
            failed: [],
            unauthorized: [],
        };
        const extensionsStatus = vi.fn(async () => initial);
        const settingsWrite = vi.fn(async () => ({ global: { disabledExtensions: ["demo"] } }));
        const restart = vi.fn(async () => {});
        const client = { extensionsStatus, settingsWrite } as unknown as TacoClient;
        const options = queryWrapper();
        const first = renderHook(() => usePluginsPane(client, true, "/a", restart), options);
        const second = renderHook(() => usePluginsPane(client, true, "/b", restart), options);
        await waitFor(() => expect(second.result.current.extensionStatus).toEqual(initial));
        await act(async () => first.result.current.toggleExtension("demo", true));
        await waitFor(() =>
            expect(second.result.current.extensionStatus?.disabled).toEqual(["demo"]),
        );
        expect(first.result.current.extensionPendingRestart).toBe(true);
        expect(settingsWrite).toHaveBeenCalledWith({ global: { disabledExtensions: ["demo"] } });
        extensionsStatus.mockResolvedValue({ ...initial, disabled: ["demo"] });
        await act(async () => first.result.current.restartForPlugins());
        expect(restart).toHaveBeenCalledTimes(1);
        expect(first.result.current.extensionPendingRestart).toBe(false);
        await waitFor(() =>
            expect(second.result.current.extensionStatus?.disabled).toEqual(["demo"]),
        );
    });

    it("keeps the query cache unchanged after a rejected plugin configuration write", async () => {
        const initial: ExtensionsStatusResult = {
            loaded: [],
            disabled: [],
            failed: [],
            unauthorized: [],
        };
        const client = {
            extensionsStatus: vi.fn(async () => initial),
            settingsWrite: vi.fn(async () => {
                throw new Error("disk full");
            }),
        } as unknown as TacoClient;
        const options = queryWrapper();
        const view = renderHook(() => usePluginsPane(client, true, "/a", async () => {}), options);
        await waitFor(() => expect(view.result.current.extensionStatus).toEqual(initial));
        await act(async () => view.result.current.toggleExtension("demo", true));
        expect(view.result.current.extensionError).toBe("disk full");
        expect(options.queryClient.getQueryData(resourceQueryKey(client, "plugins"))).toEqual(
            initial,
        );
        expect(view.result.current.extensionPendingRestart).toBe(false);
    });
    it("reports a non-Error catalog rejection instead of an empty error banner", async () => {
        const client = {
            toolsList: vi.fn().mockRejectedValue("catalog unavailable"),
        } as unknown as TacoClient;
        const view = renderHook(() => useToolsPane(client, true, "/a"), queryWrapper());
        await waitFor(() => expect(view.result.current.error).toBe("catalog unavailable"));
    });
});
