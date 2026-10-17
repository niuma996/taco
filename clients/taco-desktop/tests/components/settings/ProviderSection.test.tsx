/**
 * ProviderSection — deleting a custom provider must not leave the global
 * config pointing at it.
 *
 * The bug this pins: `defaultProvider` naming a deleted provider resolves to
 * nothing in the catalog, so every later `session.create` fails with
 * "no model configured — select a provider and model in Settings" while the
 * UI shows a perfectly good default model selected. No catalog entry can ever
 * bring a deleted provider id back, so the stale qualifier has to go with it.
 * Clearing it lets the default-model lookup fall back to a cross-provider
 * search by id, which finds the same model id when the user has added it on
 * another provider.
 */

import type { CustomProviderConfig, ProviderView, WorkspaceId } from "@taco-ai/protocol";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProviderSection } from "../../../src/components/settings/ProviderSection";
import type { TacoClient } from "../../../src/lib/clients/tacoClient.ts";
import { applyGlobalConfig } from "../../../src/lib/globalConfig";

vi.mock("react-i18next", () => ({
    useTranslation: vi.fn(() => ({
        t: (key: string) => key,
        i18n: { language: "en" },
    })),
}));

afterEach(cleanup);

const WS = "/tmp/ws" as WorkspaceId;

const RELAY: CustomProviderConfig = {
    id: "custom:relay",
    name: "Relay",
    api: "chatcomplete",
    baseUrl: "https://relay.example/v1",
    models: [{ id: "relay-fast" }],
};

const RELAY_VIEW: ProviderView = {
    id: RELAY.id,
    name: RELAY.name,
    configured: true,
    custom: true,
    models: [{ provider: RELAY.id, id: "relay-fast", origin: "custom" }],
};

function makeClient(settingsWrite: TacoClient["settingsWrite"]): TacoClient {
    return {
        settingsWrite,
        providersList: () => Promise.resolve({ providers: [RELAY_VIEW] }),
    } as unknown as TacoClient;
}

async function openRelay(client: TacoClient, global: Record<string, unknown>) {
    // Seed the global-config cache directly — the section reads its fields from
    // there, and the save path refreshes it via applyGlobalConfig on success.
    applyGlobalConfig(global as never);
    render(<ProviderSection client={client} workspace={WS} />);
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText("Relay — settings.providerConfigured"));
    return user;
}

describe("ProviderSection — deleting the default custom provider", () => {
    it("clears defaultProvider when it names the deleted provider", async () => {
        const settingsWrite = vi.fn().mockResolvedValue({ global: {} });
        const client = makeClient(settingsWrite as unknown as TacoClient["settingsWrite"]);
        const user = await openRelay(client, {
            defaultModel: "relay-fast",
            defaultProvider: RELAY.id,
            customProviders: [RELAY],
        });

        // Delete is gated behind a confirm that names the consequence.
        await user.click(screen.getByRole("button", { name: "settings.customProviderDeleteBtn" }));
        expect(settingsWrite).not.toHaveBeenCalled();
        expect(screen.getByText("settings.customProviderDeleteConfirmDefault")).toBeTruthy();
        await user.click(
            screen.getByRole("button", { name: "settings.customProviderDeleteConfirmBtn" }),
        );

        await waitFor(() => expect(settingsWrite).toHaveBeenCalled());
        const patch = (settingsWrite.mock.calls[0] as [{ global: Record<string, unknown> }])[0]
            .global;
        expect(patch.customProviders).toEqual([]);
        expect(patch.apiKeys).toEqual({ [RELAY.id]: "" });
        // defaultModel is kept — only the now-dangling provider qualifier goes.
        expect("defaultProvider" in patch).toBe(true);
        // JSON-RPC needs an explicit null to clear the persisted scalar;
        // undefined-valued properties are omitted during serialization.
        expect(patch.defaultProvider).toBeNull();
    });

    it("leaves defaultProvider alone when it names a different provider", async () => {
        const settingsWrite = vi.fn().mockResolvedValue({ global: {} });
        const client = makeClient(settingsWrite as unknown as TacoClient["settingsWrite"]);
        const user = await openRelay(client, {
            defaultModel: "MiniMax-M2",
            defaultProvider: "minimax-cn",
            customProviders: [RELAY],
        });

        await user.click(screen.getByRole("button", { name: "settings.customProviderDeleteBtn" }));
        expect(screen.getByText("settings.customProviderDeleteConfirmPlain")).toBeTruthy();
        await user.click(
            screen.getByRole("button", { name: "settings.customProviderDeleteConfirmBtn" }),
        );

        await waitFor(() => expect(settingsWrite).toHaveBeenCalled());
        const patch = (settingsWrite.mock.calls[0] as [{ global: Record<string, unknown> }])[0]
            .global;
        expect("defaultProvider" in patch).toBe(false);
    });

    it("cancelling the confirm does not delete", async () => {
        const settingsWrite = vi.fn().mockResolvedValue({ global: {} });
        const client = makeClient(settingsWrite as unknown as TacoClient["settingsWrite"]);
        const user = await openRelay(client, {
            defaultModel: "relay-fast",
            defaultProvider: RELAY.id,
            customProviders: [RELAY],
        });

        await user.click(screen.getByRole("button", { name: "settings.customProviderDeleteBtn" }));
        await user.click(screen.getByRole("button", { name: "settings.providerCancel" }));
        expect(settingsWrite).not.toHaveBeenCalled();
    });
});
