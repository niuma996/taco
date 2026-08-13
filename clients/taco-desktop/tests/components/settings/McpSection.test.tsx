/**
 * McpSection — per-entry MCP config RPCs.
 *
 * Pins the current behaviour: list is a masked McpServerConfigView[];
 * toggle/delete/add/edit go through mcp.updateConfig / mcp.deleteConfig /
 * mcp.createConfig / (mcp.getConfig + mcp.updateConfig) respectively, and
 * settings.write is never used for mcpServers. Keeps two earlier behaviors:
 *   1. (Fake success) A failed config save must leave the form open and NOT
 *      trigger onRestart.
 *   2. (Disabled flag) Editing a server that is `enabled: false` must keep the
 *      flag — the server merges the patch field-wise, and the mock echoes the
 *      merged server back into the list.
 */

import type { McpServerConfig, McpServerConfigView } from "@taco-ai/protocol";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { McpSection } from "../../../src/components/settings/McpSection";
import { loadGlobalConfig } from "../../../src/lib/globalConfig";
import type { TacoClient } from "../../../src/lib/tacoClientTauri.ts";

vi.mock("react-i18next", () => ({
    useTranslation: vi.fn(() => ({
        t: (key: string, params?: Record<string, unknown>) =>
            params ? `${key}:${JSON.stringify(params)}` : key,
        i18n: { language: "en" },
    })),
}));

afterEach(() => {
    cleanup();
});

type McpUpdateConfigMock = (
    id: string,
    patch: Partial<McpServerConfig>,
) => Promise<{
    server: McpServerConfigView;
    requiresRestart: true;
}>;

/**
 * Mock TacoClient for McpSection. Uses `satisfies Partial<TacoClient>` so TypeScript
 * infers literal return types from the default implementations (which include
 * spread-based server objects) rather than enforcing the strict server type.
 * Callers pass overrides as direct arguments.
 */
function makeClient(...overrides: Partial<TacoClient>[]): TacoClient {
    return Object.assign(
        {
            settingsGet: () => Promise.resolve({ global: { mcpServers: [] } }),
            settingsWrite: () => Promise.resolve({ global: {} }),
            mcpListServers: () => Promise.resolve({ servers: [] }),
            mcpGetConfig: () =>
                Promise.resolve({ config: { id: "echo", transport: "stdio", command: "node" } }),
            mcpCreateConfig: () =>
                Promise.resolve({
                    server: { id: "echo", transport: "stdio" },
                    requiresRestart: true,
                }),
            mcpUpdateConfig: (id, patch) =>
                Promise.resolve({
                    server: { id, transport: patch.transport ?? "stdio", ...patch },
                    requiresRestart: true,
                }),
            mcpDeleteConfig: () => Promise.resolve({ deleted: "echo", requiresRestart: true }),
        } satisfies Partial<TacoClient>,
        ...overrides,
    );
}

const ECHO_VIEW: McpServerConfigView = { id: "echo", transport: "stdio" };
const ECHO_FULL: McpServerConfig = { id: "echo", transport: "stdio", command: "node" };
const ECHO_DISABLED_FULL: McpServerConfig = {
    id: "echo",
    transport: "stdio",
    command: "node",
    enabled: false,
};

describe("McpSection", () => {
    it("edits via mcpGetConfig + mcpUpdateConfig and never calls settingsWrite for mcpServers", async () => {
        const settingsWrite = vi.fn().mockResolvedValue({ global: {} });
        const mcpGetConfig = vi.fn().mockResolvedValue({ config: ECHO_FULL });
        const mcpUpdateConfig = vi.fn<McpUpdateConfigMock>().mockResolvedValue({
            server: { id: "echo", transport: "stdio", command: "node2" } as McpServerConfigView,
            requiresRestart: true,
        });
        const onRestart = vi.fn().mockResolvedValue(undefined);

        const client = makeClient({
            settingsWrite,
            mcpGetConfig,
            mcpUpdateConfig,
            settingsGet: () => Promise.resolve({ global: { mcpServers: [ECHO_VIEW] } }),
        });
        await loadGlobalConfig(client);
        const user = userEvent.setup();
        render(<McpSection client={client} onRestart={onRestart} />);

        // Open Edit on the "echo" card, change the command, save.
        const editBtn = await screen.findByLabelText("settings.mcpServerEditBtn");
        await user.click(editBtn);
        const commandInput = await screen.findByPlaceholderText(/npx/);
        await user.clear(commandInput);
        await user.type(commandInput, "node2");
        await user.click(screen.getByRole("button", { name: "settings.mcpServerSave" }));

        // The full single config is fetched first, then the update patch is sent.
        await waitFor(() => {
            expect(mcpGetConfig).toHaveBeenCalledWith("echo");
        });
        await waitFor(() => {
            expect(mcpUpdateConfig).toHaveBeenCalledWith(
                "echo",
                expect.objectContaining({ command: "node2" }),
            );
        });
        // settingsWrite is never invoked on the edit path.
        expect(settingsWrite).not.toHaveBeenCalled();
        // Successful edit auto-restarts.
        await waitFor(() => {
            expect(onRestart).toHaveBeenCalledTimes(1);
        });
    });

    it("toggles via mcpUpdateConfig", async () => {
        const mcpUpdateConfig = vi.fn<McpUpdateConfigMock>().mockResolvedValue({
            server: { id: "echo", transport: "stdio", enabled: false },
            requiresRestart: true,
        });
        const client = makeClient({
            mcpUpdateConfig,
            settingsGet: () => Promise.resolve({ global: { mcpServers: [ECHO_VIEW] } }),
        });
        await loadGlobalConfig(client);
        const user = userEvent.setup();
        render(<McpSection client={client} onRestart={vi.fn().mockResolvedValue(undefined)} />);

        const toggle = await screen.findByLabelText(/mcpServerToggleEnabled/);
        await user.click(toggle);

        await waitFor(() => {
            expect(mcpUpdateConfig).toHaveBeenCalledWith("echo", { enabled: false });
        });
    });

    it("deletes via mcpDeleteConfig", async () => {
        const mcpDeleteConfig = vi
            .fn()
            .mockResolvedValue({ deleted: "echo", requiresRestart: true as const });
        const client = makeClient({
            mcpDeleteConfig,
            settingsGet: () => Promise.resolve({ global: { mcpServers: [ECHO_VIEW] } }),
        });
        await loadGlobalConfig(client);
        const user = userEvent.setup();
        render(<McpSection client={client} onRestart={vi.fn().mockResolvedValue(undefined)} />);

        const deleteBtn = await screen.findByLabelText("settings.mcpServerDelete");
        await user.click(deleteBtn);

        await waitFor(() => {
            expect(mcpDeleteConfig).toHaveBeenCalledWith("echo");
        });
        // Card is gone from the list.
        await waitFor(() => {
            expect(screen.queryByLabelText("settings.mcpServerEditBtn")).toBeNull();
        });
    });

    it("keeps the form open and does not restart when the config save fails", async () => {
        const settingsWrite = vi.fn().mockResolvedValue({ global: {} });
        const onRestart = vi.fn().mockResolvedValue(undefined);
        const mcpCreateConfig = vi.fn().mockImplementation(
            () =>
                new Promise<{ server: McpServerConfigView; requiresRestart: true }>(
                    (_resolve, reject) => {
                        setTimeout(() => reject(new Error("disk full")), 30);
                    },
                ),
        );

        const client = makeClient({ settingsWrite, mcpCreateConfig });
        await loadGlobalConfig(client);
        const user = userEvent.setup();
        render(<McpSection client={client} onRestart={onRestart} />);

        await user.click(await screen.findByText("settings.mcpServerAddBtn"));
        await user.type(await screen.findByPlaceholderText(/e\.g\./), "echo");
        await user.type(screen.getByPlaceholderText(/npx/), "node");

        const saveBtn = screen.getByRole("button", { name: "settings.mcpServerSave" });
        expect((saveBtn as unknown as HTMLButtonElement).disabled).toBe(false);
        await user.click(saveBtn);

        // While the create is pending, the form's "Saving…" state must disable
        // the Save button so a double-click cannot fire a second RPC.
        const savingBtn = await screen.findByRole("button", {
            name: "settings.mcpServerSaving",
        });
        expect((savingBtn as unknown as HTMLButtonElement).disabled).toBe(true);

        // Let the rejection settle.
        await new Promise((r) => setTimeout(r, 60));

        expect(onRestart).not.toHaveBeenCalled();
        // Form must still be visible — the user can retry.
        expect(screen.queryByRole("button", { name: "settings.mcpServerSave" })).not.toBeNull();
        // Error banner surfaces the cause.
        expect(screen.getByText(/disk full/)).toBeTruthy();
    });

    it("preserves enabled=false across edit save", async () => {
        const mcpGetConfig = vi.fn().mockResolvedValue({ config: ECHO_DISABLED_FULL });
        const mcpUpdateConfig = vi.fn<McpUpdateConfigMock>().mockResolvedValue({
            server: {
                id: "echo",
                transport: "stdio",
                command: "node2",
                enabled: false,
            } as McpServerConfigView,
            requiresRestart: true,
        });
        const onRestart = vi.fn().mockResolvedValue(undefined);
        const settingsWrite = vi.fn().mockResolvedValue({ global: {} });

        const client = makeClient({
            settingsWrite,
            mcpGetConfig,
            mcpUpdateConfig,
            settingsGet: () =>
                Promise.resolve({
                    global: { mcpServers: [{ id: "echo", transport: "stdio", enabled: false }] },
                }),
        });
        await loadGlobalConfig(client);
        const user = userEvent.setup();
        render(<McpSection client={client} onRestart={onRestart} />);

        // Open the Edit form for the disabled server via its aria-label.
        const editBtn = await screen.findByLabelText("settings.mcpServerEditBtn");
        await user.click(editBtn);

        // Change the command (the only field the form exposes). Save.
        const commandInput = await screen.findByPlaceholderText(/npx/);
        await user.clear(commandInput);
        await user.type(commandInput, "node2");
        await user.click(screen.getByRole("button", { name: "settings.mcpServerSave" }));

        // The form output is sent as a field-wise patch — enabled:false is not
        // in the form, so it must not appear in the patch (the server merges,
        // keeping the disabled flag on disk).
        await waitFor(() => {
            expect(mcpUpdateConfig).toHaveBeenCalledWith(
                "echo",
                expect.objectContaining({ command: "node2" }),
            );
        });
        const patch = mcpUpdateConfig.mock.calls[0]?.[1] ?? {};
        expect(patch.enabled).toBeUndefined();
        // The mock echoes the merged server (server-side merge semantics), so
        // the list still shows enabled:false after the save — the disabled
        // badge from the "echo" card must survive the edit round-trip.
        await waitFor(() => {
            expect(onRestart).toHaveBeenCalledTimes(1);
        });
        expect(screen.getByText("settings.mcpServerDisabled")).toBeTruthy();
        // No full-array settings.write ever fires.
        expect(settingsWrite).not.toHaveBeenCalled();
    });
});
