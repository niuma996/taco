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

const BUILTIN_VIEW: ProviderView = {
    id: "anthropic",
    name: "Anthropic",
    configured: true,
    custom: false,
    models: [{ provider: "anthropic", id: "claude-sonnet", origin: "builtin" }],
};

/** A client whose catalog mixes a built-in provider with the custom relay. */
function makeIconClient(): TacoClient {
    return {
        settingsWrite: vi.fn().mockResolvedValue({ global: {} }),
        providersList: () => Promise.resolve({ providers: [BUILTIN_VIEW, RELAY_VIEW] }),
    } as unknown as TacoClient;
}

async function openRelay(client: TacoClient, global: Record<string, unknown>) {
    // Seed the global-config cache directly — the section reads its fields from
    // there, and the save path refreshes it via applyGlobalConfig on success.
    applyGlobalConfig(global as never);
    render(<ProviderSection client={client} workspace={WS} />);
    const user = userEvent.setup({ delay: null });
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

describe("ProviderSection — brand marks", () => {
    it("paints a vendored mask for a built-in provider", async () => {
        applyGlobalConfig({ customProviders: [] } as never);
        render(<ProviderSection client={makeIconClient()} workspace={WS} />);
        await screen.findByLabelText("Anthropic — settings.providerConfigured");
        const card = screen.getByLabelText("Anthropic — settings.providerConfigured");
        const icon = card.querySelector(".provider-icon");
        expect(icon).toBeTruthy();
        expect(icon?.classList.contains("provider-icon--fallback")).toBe(false);
        // The vendored SVG is applied as a data-URI mask over the element's
        // background, so the colour follows the theme.
        expect((icon as HTMLElement).style.maskImage).toContain("data:image/svg+xml");
    });

    it("falls back to a neutral mark for a custom provider", async () => {
        applyGlobalConfig({ customProviders: [RELAY] } as never);
        render(<ProviderSection client={makeIconClient()} workspace={WS} />);
        await screen.findByLabelText("Relay — settings.providerConfigured");
        const card = screen.getByLabelText("Relay — settings.providerConfigured");
        const icon = card.querySelector(".provider-icon");
        expect(icon?.classList.contains("provider-icon--fallback")).toBe(true);
    });

    it("keeps the status dot outside the title line, in the card corner", async () => {
        applyGlobalConfig({ customProviders: [] } as never);
        render(<ProviderSection client={makeIconClient()} workspace={WS} />);
        await screen.findByLabelText("Anthropic — settings.providerConfigured");
        const card = screen.getByLabelText("Anthropic — settings.providerConfigured");
        const dot = card.querySelector(".provider-row-dot");
        expect(dot).toBeTruthy();
        // The dot is a direct child of the card, not of the title line.
        expect(dot?.parentElement).toBe(card);
        expect(card.querySelector(".provider-row-title .provider-row-dot")).toBeNull();
    });
});
