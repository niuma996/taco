import type { MemoryListResult } from "@taco-ai/protocol";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigurationMemoryController } from "../../src/components/configuration/ConfigurationMemoryController";
import { ConfigurationPluginsController } from "../../src/components/configuration/ConfigurationPluginsController";
import type { TacoClient } from "../../src/lib/clients/tacoClient";
import { applyGlobalConfig } from "../../src/lib/globalConfig";
import { onMemoryChangedEvent } from "../../src/lib/memoryEvents";
import type { MemoryPaneProps } from "../../src/views/MemoryPane";
import type { PluginsPaneProps } from "../../src/views/PluginsPane";
import { queryWrapper } from "../helpers/queryWrapper";

vi.mock("../../src/views/MemoryPane", () => ({
    MemoryPane: (props: MemoryPaneProps) => (
        <div data-testid="memory-view" data-target={props.target} />
    ),
}));

vi.mock("../../src/views/PluginsPane", () => ({
    PluginsPane: (props: PluginsPaneProps) => (
        <div
            data-testid="plugins-view"
            data-pending={props.pendingRestart}
            data-restarting={props.restarting}
        >
            <button type="button" onClick={() => props.onToggle("demo", true)}>
                toggle-plugin
            </button>
            <button type="button" onClick={props.onRestart}>
                restart-plugins
            </button>
        </div>
    ),
}));

afterEach(cleanup);

const memoryResult: MemoryListResult = {
    enabled: true,
    memoryContent: "# Memory\n",
    memoryHash: "hash",
    topics: [],
    dreamScheduled: true,
};

function memoryProps(client: TacoClient, active: boolean) {
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
        notify: vi.fn(),
    };
}

describe("memory and plugins controllers", () => {
    it("refreshes a hidden memory target only for matching change events", async () => {
        const memoryList = vi.fn(async () => memoryResult);
        const callProcess = vi.fn(async () => ({ job: null }));
        const client = { memoryList, callProcess } as unknown as TacoClient;
        const view = render(<ConfigurationMemoryController {...memoryProps(client, false)} />, {
            ...queryWrapper(),
        });

        expect(screen.queryByTestId("memory-view")).toBeNull();
        onMemoryChangedEvent("/repo-b");
        expect(memoryList).not.toHaveBeenCalled();
        onMemoryChangedEvent("/repo-a");
        await waitFor(() => expect(memoryList).toHaveBeenCalledTimes(1));
        expect(memoryList).toHaveBeenLastCalledWith({ workspace: "/repo-a" });

        view.rerender(<ConfigurationMemoryController {...memoryProps(client, true)} />);
        await screen.findByTestId("memory-view");
        await waitFor(() => expect(memoryList).toHaveBeenCalledTimes(2));
    });

    it("preserves pending restart and finishes a restart while plugins are hidden", async () => {
        applyGlobalConfig({ disabledExtensions: [] });
        let finishRestart = () => {};
        const restartSidecar = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    finishRestart = resolve;
                }),
        );
        const extensionsStatus = vi.fn(async () => ({
            loaded: [],
            disabled: [],
            failed: [],
            unauthorized: [],
        }));
        const settingsWrite = vi.fn(async () => ({
            global: { disabledExtensions: ["demo"] },
        }));
        const client = { extensionsStatus, settingsWrite } as unknown as TacoClient;
        const props = { active: true, client, activeCwd: "/repo-a", restartSidecar };
        const view = render(<ConfigurationPluginsController {...props} />, {
            ...queryWrapper(),
        });

        await waitFor(() => expect(extensionsStatus).toHaveBeenCalledTimes(1));
        fireEvent.click(screen.getByRole("button", { name: "toggle-plugin" }));
        await waitFor(() =>
            expect(screen.getByTestId("plugins-view").getAttribute("data-pending")).toBe("true"),
        );

        view.rerender(<ConfigurationPluginsController {...props} active={false} />);
        expect(screen.queryByTestId("plugins-view")).toBeNull();
        view.rerender(<ConfigurationPluginsController {...props} />);
        expect(screen.getByTestId("plugins-view").getAttribute("data-pending")).toBe("true");

        fireEvent.click(screen.getByRole("button", { name: "restart-plugins" }));
        await waitFor(() => expect(restartSidecar).toHaveBeenCalledTimes(1));
        view.rerender(<ConfigurationPluginsController {...props} active={false} />);
        finishRestart();
        view.rerender(<ConfigurationPluginsController {...props} />);
        await waitFor(() =>
            expect(screen.getByTestId("plugins-view").getAttribute("data-pending")).toBe("false"),
        );
        expect(screen.getByTestId("plugins-view").getAttribute("data-restarting")).toBe("false");
    });
});
