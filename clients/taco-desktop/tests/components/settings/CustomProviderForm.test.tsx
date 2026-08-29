/**
 * CustomProviderForm — "fetch models" flow.
 *
 * Covers the button's availability rules (protocol / baseUrl / key), the
 * dedupe-and-append write into the textarea, and how each
 * `provider.listModels` failure reason surfaces. The RPC is a vi.fn(); no
 * sidecar involved.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CustomProviderForm } from "../../../src/components/settings/CustomProviderForm";
import type { TacoClient } from "../../../src/lib/clients/tacoClient.ts";

vi.mock("react-i18next", () => ({
    useTranslation: vi.fn(() => ({
        t: (key: string) => key,
        i18n: { language: "en" },
    })),
}));

afterEach(cleanup);

type ListModels = TacoClient["providerListModels"];

function renderForm(listModels: ListModels) {
    const client = { providerListModels: listModels } as unknown as TacoClient;
    render(
        <CustomProviderForm existingIds={[]} client={client} onSave={vi.fn()} onCancel={vi.fn()} />,
    );
}

const fetchButton = () =>
    screen.getByRole("button", { name: "settings.customProviderFetch" }) as HTMLButtonElement;
const modelsBox = () =>
    screen.getByPlaceholderText("settings.customProviderModelsPlaceholder") as HTMLTextAreaElement;

/** baseUrl + key are both required before the button unlocks. */
async function fillPrerequisites(user: ReturnType<typeof userEvent.setup>) {
    await user.type(
        screen.getByPlaceholderText("settings.customProviderBaseUrlPlaceholder"),
        "https://api.example.com/v1",
    );
    await user.type(
        screen.getByPlaceholderText("settings.customProviderKeyPlaceholder"),
        "sk-test",
    );
}

describe("CustomProviderForm — model discovery", () => {
    it("disables the fetch button until baseUrl and apiKey are filled", async () => {
        const user = userEvent.setup();
        renderForm(vi.fn());
        expect(fetchButton().disabled).toBe(true);

        await user.type(
            screen.getByPlaceholderText("settings.customProviderBaseUrlPlaceholder"),
            "https://api.example.com/v1",
        );
        // baseUrl alone is not enough — the request needs a key to authenticate.
        expect(fetchButton().disabled).toBe(true);

        await user.type(
            screen.getByPlaceholderText("settings.customProviderKeyPlaceholder"),
            "sk-test",
        );
        expect(fetchButton().disabled).toBe(false);
    });

    it("appends fetched ids to the textarea", async () => {
        const user = userEvent.setup();
        const listModels = vi
            .fn()
            .mockResolvedValue({ ok: true, models: ["gpt-4o", "gpt-4o-mini"] });
        renderForm(listModels as unknown as ListModels);
        await fillPrerequisites(user);
        await user.click(fetchButton());

        await waitFor(() => expect(modelsBox().value).toBe("gpt-4o\ngpt-4o-mini"));
        expect(listModels).toHaveBeenCalledWith({
            baseUrl: "https://api.example.com/v1",
            api: "chatcomplete",
            apiKey: "sk-test",
        });
    });

    it("keeps ids the user already typed and skips duplicates", async () => {
        const user = userEvent.setup();
        const listModels = vi.fn().mockResolvedValue({ ok: true, models: ["mine", "fetched"] });
        renderForm(listModels as unknown as ListModels);
        await fillPrerequisites(user);
        await user.type(modelsBox(), "mine");
        await user.click(fetchButton());

        // "mine" must not be duplicated; only "fetched" is appended.
        await waitFor(() => expect(modelsBox().value).toBe("mine\nfetched"));
    });

    it("surfaces the message when the RPC reports a failure", async () => {
        const user = userEvent.setup();
        const listModels = vi.fn().mockResolvedValue({
            ok: false,
            reason: "http-error",
            message: "HTTP 401",
        });
        renderForm(listModels as unknown as ListModels);
        await fillPrerequisites(user);
        await user.click(fetchButton());

        await waitFor(() => expect(screen.getByText("HTTP 401")).toBeTruthy());
        // A failed fetch must not touch what the user typed.
        expect(modelsBox().value).toBe("");
    });

    it("reports an empty catalog as its own message", async () => {
        const user = userEvent.setup();
        const listModels = vi.fn().mockResolvedValue({ ok: true, models: [] });
        renderForm(listModels as unknown as ListModels);
        await fillPrerequisites(user);
        await user.click(fetchButton());

        await waitFor(() =>
            expect(screen.getByText("settings.customProviderFetchEmpty")).toBeTruthy(),
        );
    });

    it("surfaces a thrown transport error instead of crashing", async () => {
        const user = userEvent.setup();
        const listModels = vi.fn().mockRejectedValue(new Error("sidecar is down"));
        renderForm(listModels as unknown as ListModels);
        await fillPrerequisites(user);
        await user.click(fetchButton());

        await waitFor(() => expect(screen.getByText("sidecar is down")).toBeTruthy());
    });

    it("replaces the button with a hint when the protocol has no discovery", async () => {
        const user = userEvent.setup();
        renderForm(vi.fn());
        // Switch the protocol away from chatcomplete via the Radix Select.
        await user.click(screen.getByRole("combobox", { name: "settings.customProviderApi" }));
        await user.click(
            await screen.findByRole("option", { name: "settings.customProviderApiAnthropic" }),
        );

        expect(screen.getByText("settings.customProviderFetchUnsupported")).toBeTruthy();
        expect(screen.queryByRole("button", { name: "settings.customProviderFetch" })).toBeNull();
    });
});
