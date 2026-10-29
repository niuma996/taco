/**
 * ProviderDetailModal — model discovery (create-custom mode) and the
 * built-in provider key view (mask / reveal / extras management).
 *
 * The RPC methods are vi.fn(); no sidecar involved. The i18n mock returns
 * keys verbatim.
 */

import type { ProviderView, WorkspaceId } from "@taco-ai/protocol";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderDetailModal } from "../../../src/components/settings/ProviderDetailModal";
import type { TacoClient } from "../../../src/lib/clients/tacoClient.ts";

vi.mock("react-i18next", () => ({
    useTranslation: vi.fn(() => ({
        t: (key: string) => key,
        i18n: { language: "en" },
    })),
}));

afterEach(cleanup);

const WS = "/tmp/ws" as WorkspaceId;

type ListModels = TacoClient["providerListModels"];

function renderCreate(listModels: ListModels) {
    const client = { providerListModels: listModels } as unknown as TacoClient;
    render(
        <ProviderDetailModal
            client={client}
            workspace={WS}
            existingIds={[]}
            saving={false}
            onSaveCustom={vi.fn()}
            onClose={vi.fn()}
        />,
    );
}

const fetchButton = () =>
    screen.getByRole("button", { name: "settings.customProviderFetch" }) as HTMLButtonElement;

/** baseUrl + key are both required before the button unlocks (create mode). */
async function fillPrerequisites(user: ReturnType<typeof userEvent.setup>) {
    await user.type(
        screen.getByPlaceholderText("settings.customProviderBaseUrlPlaceholder"),
        "https://api.example.com/v1",
    );
    await user.type(screen.getByPlaceholderText("settings.providerKeyPlaceholder"), "sk-test");
}

/**
 * The editable model list and the dashed candidate list. Model-id queries must
 * be scoped to one of these: the connection-test Select renders the selected
 * model id as its trigger text, so an unscoped query matches both.
 */
function modelList() {
    return document.querySelector(".provider-detail-models") as HTMLElement;
}
function candidateList() {
    return document.querySelector(".provider-detail-fetched") as HTMLElement;
}

describe("ProviderDetailModal — create-custom model discovery", () => {
    it("disables the fetch button until baseUrl and apiKey are filled", async () => {
        const user = userEvent.setup();
        renderCreate(vi.fn());
        expect(fetchButton().disabled).toBe(true);

        await user.type(
            screen.getByPlaceholderText("settings.customProviderBaseUrlPlaceholder"),
            "https://api.example.com/v1",
        );
        // baseUrl alone is not enough — the request needs a key to authenticate.
        expect(fetchButton().disabled).toBe(true);

        await user.type(screen.getByPlaceholderText("settings.providerKeyPlaceholder"), "sk-test");
        expect(fetchButton().disabled).toBe(false);
    });

    it("lists fetched ids row-by-row and moves one into the model list on add", async () => {
        const user = userEvent.setup();
        const listModels = vi
            .fn()
            .mockResolvedValue({ ok: true, models: ["gpt-4o", "gpt-4o-mini"] });
        renderCreate(listModels as unknown as ListModels);
        await fillPrerequisites(user);
        await user.click(fetchButton());

        expect(listModels).toHaveBeenCalledWith({
            baseUrl: "https://api.example.com/v1",
            api: "chatcomplete",
            apiKey: "sk-test",
        });
        // Candidates land in the dashed fetch list, each with its own add button.
        const fetchedBox = await within(candidateList()).findByText("gpt-4o-mini");
        const fetchedRow = fetchedBox.closest(".provider-detail-model-row") as HTMLElement;
        await user.click(
            within(fetchedRow.parentElement as HTMLElement).getAllByRole("button", {
                name: "settings.providerModelAdd",
            })[0],
        );
        // Added rows leave the fetch list — only the other candidate remains there.
        await waitFor(() => expect(within(modelList()).getByText("gpt-4o")).toBeTruthy());
        expect(within(candidateList()).queryByText("gpt-4o")).toBeNull();
    });

    it("skips fetched ids the user already added manually", async () => {
        const user = userEvent.setup();
        const listModels = vi.fn().mockResolvedValue({ ok: true, models: ["mine", "fetched"] });
        renderCreate(listModels as unknown as ListModels);
        await fillPrerequisites(user);
        const manual = screen.getByPlaceholderText("settings.providerModelAddPlaceholder");
        await user.type(manual, "mine{Enter}");
        await user.click(fetchButton());

        await waitFor(() => expect(within(candidateList()).getByText("fetched")).toBeTruthy());
        // "mine" appears once (the manual row) — the fetched duplicate is filtered out.
        expect(within(modelList()).getAllByText("mine").length).toBe(1);
        expect(within(candidateList()).queryByText("mine")).toBeNull();
    });

    it("re-filters the candidate list when a model is added after the fetch", async () => {
        const user = userEvent.setup();
        const listModels = vi.fn().mockResolvedValue({ ok: true, models: ["alpha", "beta"] });
        renderCreate(listModels as unknown as ListModels);
        await fillPrerequisites(user);
        await user.click(fetchButton());
        await waitFor(() => expect(within(candidateList()).getByText("alpha")).toBeTruthy());

        // Adding "beta" after the fetch must drop it from the candidate list —
        // the filter is derived per render, not snapshotted at fetch time.
        const manual = screen.getByPlaceholderText("settings.providerModelAddPlaceholder");
        await user.type(manual, "beta{Enter}");

        await waitFor(() => expect(within(modelList()).getAllByText("beta").length).toBe(1));
        expect(within(candidateList()).queryByText("beta")).toBeNull();
        expect(within(candidateList()).getAllByText("alpha").length).toBe(1);
    });

    it("collapses duplicate ids returned by the endpoint into one candidate", async () => {
        const user = userEvent.setup();
        const listModels = vi.fn().mockResolvedValue({ ok: true, models: ["dup", "dup", "other"] });
        renderCreate(listModels as unknown as ListModels);
        await fillPrerequisites(user);
        await user.click(fetchButton());

        await waitFor(() => expect(within(candidateList()).getByText("other")).toBeTruthy());
        expect(within(candidateList()).getAllByText("dup").length).toBe(1);
    });

    it("surfaces the message when the RPC reports a failure", async () => {
        const user = userEvent.setup();
        const listModels = vi.fn().mockResolvedValue({
            ok: false,
            reason: "http-error",
            message: "HTTP 401",
        });
        renderCreate(listModels as unknown as ListModels);
        await fillPrerequisites(user);
        await user.click(fetchButton());

        await waitFor(() => expect(screen.getByText("HTTP 401")).toBeTruthy());
    });

    it("reports an empty catalog as its own message", async () => {
        const user = userEvent.setup();
        const listModels = vi.fn().mockResolvedValue({ ok: true, models: [] });
        renderCreate(listModels as unknown as ListModels);
        await fillPrerequisites(user);
        await user.click(fetchButton());

        await waitFor(() =>
            expect(screen.getByText("settings.customProviderFetchEmpty")).toBeTruthy(),
        );
    });

    it("surfaces a thrown transport error instead of crashing", async () => {
        const user = userEvent.setup();
        const listModels = vi.fn().mockRejectedValue(new Error("sidecar is down"));
        renderCreate(listModels as unknown as ListModels);
        await fillPrerequisites(user);
        await user.click(fetchButton());

        await waitFor(() => expect(screen.getByText("sidecar is down")).toBeTruthy());
    });

    it("keeps the fetch button available for the response protocol", async () => {
        const user = userEvent.setup();
        const listModels = vi.fn().mockResolvedValue({ ok: true, models: ["gpt-5"] });
        renderCreate(listModels as unknown as ListModels);
        // The Responses API differs only in its inference endpoint — the model
        // catalog is the same {baseUrl}/models, so discovery stays enabled.
        await user.click(screen.getByRole("combobox", { name: "settings.customProviderApi" }));
        await user.click(
            await screen.findByRole("option", { name: "settings.customProviderApiResponse" }),
        );
        await fillPrerequisites(user);
        await user.click(fetchButton());

        await waitFor(() => expect(within(candidateList()).getByText("gpt-5")).toBeTruthy());
        expect(listModels).toHaveBeenCalledWith({
            baseUrl: "https://api.example.com/v1",
            api: "response",
            apiKey: "sk-test",
        });
    });
});

describe("ProviderDetailModal — built-in provider", () => {
    const provider: ProviderView = {
        id: "minimax",
        name: "MiniMax",
        configured: true,
        custom: false,
        models: [
            { provider: "minimax", id: "MiniMax-M2", origin: "builtin" },
            { provider: "minimax", id: "MiniMax-M3.1", origin: "extra" },
        ],
    };

    function renderBuiltin(revealKey?: TacoClient["providersRevealKey"]) {
        const client = {
            providersRevealKey: revealKey ?? vi.fn(),
        } as unknown as TacoClient;
        const onSaveBuiltin = vi.fn().mockResolvedValue(undefined);
        render(
            <ProviderDetailModal
                client={client}
                workspace={WS}
                provider={provider}
                existingIds={[]}
                mask="sk-ant-…AbCd"
                saving={false}
                onSaveBuiltin={onSaveBuiltin}
                onClose={vi.fn()}
            />,
        );
        return { onSaveBuiltin };
    }

    it("shows the masked key and reveals plaintext via providers.revealKey", async () => {
        const user = userEvent.setup();
        const revealKey = vi.fn().mockResolvedValue({ key: "sk-plain-text" });
        renderBuiltin(revealKey);

        expect(screen.getByText("sk-ant-…AbCd")).toBeTruthy();
        await user.click(screen.getByRole("button", { name: "settings.providerDetailReveal" }));

        await waitFor(() => expect(screen.getByText("sk-plain-text")).toBeTruthy());
        expect(revealKey).toHaveBeenCalledWith("/tmp/ws", "minimax");
        // Toggle back to the mask.
        await user.click(screen.getByRole("button", { name: "settings.providerDetailHide" }));
        await waitFor(() => expect(screen.getByText("sk-ant-…AbCd")).toBeTruthy());
    });

    it("renders builtin rows with a hide button and extras with a remove button", () => {
        renderBuiltin();
        // Static row: badge + hide (moves it to the removed section).
        const staticRow = within(modelList())
            .getByText("MiniMax-M2")
            .closest(".provider-detail-model-row") as HTMLElement;
        expect(within(staticRow).getByText("settings.providerOriginBuiltin")).toBeTruthy();
        expect(
            within(staticRow).getByRole("button", { name: "settings.providerModelHide" }),
        ).toBeTruthy();
        // Extra row: badge + remove button.
        const extraRow = within(modelList())
            .getByText("MiniMax-M3.1")
            .closest(".provider-detail-model-row") as HTMLElement;
        expect(within(extraRow).getByText("settings.providerOriginExtra")).toBeTruthy();
        expect(
            within(extraRow).getByRole("button", { name: "settings.providerModelRemove" }),
        ).toBeTruthy();
    });

    it("saves extras and hidden without touching the key when it stays in view mode", async () => {
        const user = userEvent.setup();
        const { onSaveBuiltin } = renderBuiltin();
        await user.click(screen.getByRole("button", { name: "settings.providerModelRemove" }));
        await user.click(screen.getByRole("button", { name: "settings.providerModelHide" }));
        await user.click(screen.getByRole("button", { name: "settings.providerSaveKey" }));

        await waitFor(() =>
            expect(onSaveBuiltin).toHaveBeenCalledWith(undefined, [], ["MiniMax-M2"]),
        );
    });

    it("moves a hidden model out of the visible list instead of showing it twice", async () => {
        const user = userEvent.setup();
        renderBuiltin();
        expect(within(modelList()).getAllByText("MiniMax-M2").length).toBe(1);
        await user.click(screen.getByRole("button", { name: "settings.providerModelHide" }));
        // Exactly one row survives — now the struck-through "removed" one.
        await waitFor(() => expect(within(modelList()).getAllByText("MiniMax-M2").length).toBe(1));
        const row = within(modelList())
            .getByText("MiniMax-M2")
            .closest(".provider-detail-model-row") as HTMLElement;
        expect(row.className).toContain("provider-detail-model-row--off");
    });

    it("shows the built-in endpoint and protocol read-only", () => {
        const withEndpoint: ProviderView = {
            ...provider,
            baseUrl: "https://api.minimax.example/v1",
            api: "response",
        };
        const client = { providersRevealKey: vi.fn() } as unknown as TacoClient;
        render(
            <ProviderDetailModal
                client={client}
                workspace={WS}
                provider={withEndpoint}
                existingIds={[]}
                mask="sk-ant-…AbCd"
                saving={false}
                onSaveBuiltin={vi.fn()}
                onClose={vi.fn()}
            />,
        );
        const combo = screen.getByRole("combobox", { name: "settings.customProviderApi" });
        expect(combo.hasAttribute("disabled")).toBe(true);
        expect(
            screen.getByDisplayValue("https://api.minimax.example/v1").hasAttribute("readonly"),
        ).toBe(true);
    });

    it("hiding then restoring a builtin leaves an empty hidden list", async () => {
        const user = userEvent.setup();
        const { onSaveBuiltin } = renderBuiltin();
        await user.click(screen.getByRole("button", { name: "settings.providerModelHide" }));
        // The row moves to the removed section, tagged and struck through.
        await waitFor(() => expect(screen.getByText("settings.providerOriginHidden")).toBeTruthy());
        await user.click(screen.getByRole("button", { name: "settings.providerModelRestore" }));
        await user.click(screen.getByRole("button", { name: "settings.providerSaveKey" }));

        await waitFor(() =>
            expect(onSaveBuiltin).toHaveBeenCalledWith(undefined, [{ id: "MiniMax-M3.1" }], []),
        );
    });

    /** Open the window editor of one model row and switch it to free text. */
    async function openCustomWindowInput(
        user: ReturnType<typeof userEvent.setup>,
        modelId: string,
    ) {
        const row = within(modelList())
            .getByText(modelId)
            .closest(".provider-detail-model-row") as HTMLElement;
        await user.click(
            within(row).getByRole("button", { name: "settings.providerModelWindowEdit" }),
        );
        await user.click(within(row.parentElement as HTMLElement).getByRole("combobox"));
        await user.click(
            await screen.findByRole("option", { name: "settings.providerModelWindowCustom" }),
        );
        return within(row.parentElement as HTMLElement).getByPlaceholderText(
            "settings.providerModelWindowPlaceholder",
        ) as HTMLInputElement;
    }

    it("keeps a declared context window when the provider panel is saved", async () => {
        const user = userEvent.setup();
        const { onSaveBuiltin } = renderBuiltin();
        const windowInput = await openCustomWindowInput(user, "MiniMax-M3.1");
        await user.type(windowInput, "999999");
        await user.click(screen.getByRole("button", { name: "settings.providerSaveKey" }));

        await waitFor(() =>
            expect(onSaveBuiltin).toHaveBeenCalledWith(
                undefined,
                [{ id: "MiniMax-M3.1", contextWindow: 999999 }],
                [],
            ),
        );
    });

    it("expands k/m shorthand in the context window field", async () => {
        const user = userEvent.setup();
        const { onSaveBuiltin } = renderBuiltin();
        const windowInput = await openCustomWindowInput(user, "MiniMax-M3.1");
        await user.type(windowInput, "1024k");
        await user.click(screen.getByRole("button", { name: "settings.providerSaveKey" }));

        await waitFor(() =>
            expect(onSaveBuiltin).toHaveBeenCalledWith(
                undefined,
                [{ id: "MiniMax-M3.1", contextWindow: 1024000 }],
                [],
            ),
        );
    });

    it("shows the declared context window as a chip on the model row", () => {
        const withWindow: ProviderView = {
            ...provider,
            models: [
                { provider: "minimax", id: "MiniMax-M2", origin: "builtin" },
                {
                    provider: "minimax",
                    id: "MiniMax-M3.1",
                    origin: "extra",
                    contextWindow: 1_000_000,
                },
            ],
        };
        const client = { providersRevealKey: vi.fn() } as unknown as TacoClient;
        render(
            <ProviderDetailModal
                client={client}
                workspace={WS}
                provider={withWindow}
                existingIds={[]}
                mask="sk-ant-…AbCd"
                saving={false}
                onSaveBuiltin={vi.fn()}
                onClose={vi.fn()}
            />,
        );
        const row = within(modelList())
            .getByText("MiniMax-M3.1")
            .closest(".provider-detail-model-row") as HTMLElement;
        expect(within(row).getByTitle("settings.providerModelWindow").textContent).toContain("1m");
    });

    it("a preset choice declares that window on save", async () => {
        const user = userEvent.setup();
        const { onSaveBuiltin } = renderBuiltin();
        const row = within(modelList())
            .getByText("MiniMax-M3.1")
            .closest(".provider-detail-model-row") as HTMLElement;
        await user.click(
            within(row).getByRole("button", { name: "settings.providerModelWindowEdit" }),
        );
        const scope = row.parentElement as HTMLElement;
        await user.click(within(scope).getByRole("combobox"));
        await user.click(await screen.findByRole("option", { name: "1m" }));
        await user.click(screen.getByRole("button", { name: "settings.providerSaveKey" }));

        await waitFor(() =>
            expect(onSaveBuiltin).toHaveBeenCalledWith(
                undefined,
                [{ id: "MiniMax-M3.1", contextWindow: 1000000 }],
                [],
            ),
        );
    });

    it("switching back to the default option clears the declared window", async () => {
        const user = userEvent.setup();
        const withWindow: ProviderView = {
            ...provider,
            models: [
                { provider: "minimax", id: "MiniMax-M2", origin: "builtin" },
                {
                    provider: "minimax",
                    id: "MiniMax-M3.1",
                    origin: "extra",
                    contextWindow: 1_000_000,
                },
            ],
        };
        const client = { providersRevealKey: vi.fn() } as unknown as TacoClient;
        const onSaveBuiltin = vi.fn().mockResolvedValue(undefined);
        render(
            <ProviderDetailModal
                client={client}
                workspace={WS}
                provider={withWindow}
                existingIds={[]}
                mask="sk-ant-…AbCd"
                saving={false}
                onSaveBuiltin={onSaveBuiltin}
                onClose={vi.fn()}
            />,
        );
        const row = within(modelList())
            .getByText("MiniMax-M3.1")
            .closest(".provider-detail-model-row") as HTMLElement;
        await user.click(
            within(row).getByRole("button", { name: "settings.providerModelWindowEdit" }),
        );
        const scope = row.parentElement as HTMLElement;
        await user.click(within(scope).getByRole("combobox"));
        await user.click(
            await screen.findByRole("option", { name: "settings.providerModelWindowDefault" }),
        );
        await user.click(screen.getByRole("button", { name: "settings.providerSaveKey" }));

        await waitFor(() =>
            expect(onSaveBuiltin).toHaveBeenCalledWith(undefined, [{ id: "MiniMax-M3.1" }], []),
        );
    });

    it("keeps a declared display name when the provider panel is saved", async () => {
        const user = userEvent.setup();
        const withName: ProviderView = {
            ...provider,
            models: [
                { provider: "minimax", id: "MiniMax-M2", origin: "builtin" },
                {
                    provider: "minimax",
                    id: "MiniMax-M3.1",
                    origin: "extra",
                    name: "My Model",
                },
            ],
        };
        const client = { providersRevealKey: vi.fn() } as unknown as TacoClient;
        const onSaveBuiltin = vi.fn().mockResolvedValue(undefined);
        render(
            <ProviderDetailModal
                client={client}
                workspace={WS}
                provider={withName}
                existingIds={[]}
                mask="sk-ant-…AbCd"
                saving={false}
                onSaveBuiltin={onSaveBuiltin}
                onClose={vi.fn()}
            />,
        );
        await user.click(screen.getByRole("button", { name: "settings.providerSaveKey" }));

        // The catalog reports the id as the name when none was declared, so a
        // name that differs is a real one — and opening the panel must not
        // rewrite the entry as a bare id.
        await waitFor(() =>
            expect(onSaveBuiltin).toHaveBeenCalledWith(
                undefined,
                [{ id: "MiniMax-M3.1", name: "My Model" }],
                [],
            ),
        );
    });

    it("lists a pre-hidden static in the removed section with a restore action", () => {
        const withHidden: ProviderView = {
            ...provider,
            models: [
                ...provider.models,
                { provider: "minimax", id: "MiniMax-M1", origin: "hidden" },
            ],
        };
        const client = { providersRevealKey: vi.fn() } as unknown as TacoClient;
        render(
            <ProviderDetailModal
                client={client}
                workspace={WS}
                provider={withHidden}
                existingIds={[]}
                mask="sk-ant-…AbCd"
                saving={false}
                onSaveBuiltin={vi.fn()}
                onClose={vi.fn()}
            />,
        );
        const row = within(modelList())
            .getByText("MiniMax-M1")
            .closest(".provider-detail-model-row");
        expect(row?.className).toContain("provider-detail-model-row--off");
        expect(
            within(row as HTMLElement).getByRole("button", {
                name: "settings.providerModelRestore",
            }),
        ).toBeTruthy();
    });

    it("fetches through the saved branch ({ providerId }) when configured", async () => {
        const user = userEvent.setup();
        const listModels = vi.fn().mockResolvedValue({ ok: true, models: ["brand-new"] });
        const client = {
            providersRevealKey: vi.fn(),
            providerListModels: listModels,
        } as unknown as TacoClient;
        render(
            <ProviderDetailModal
                client={client}
                workspace={WS}
                provider={provider}
                existingIds={[]}
                mask="sk-ant-…AbCd"
                saving={false}
                onSaveBuiltin={vi.fn()}
                onClose={vi.fn()}
            />,
        );
        await user.click(fetchButton());

        await waitFor(() => expect(within(candidateList()).getByText("brand-new")).toBeTruthy());
        expect(listModels).toHaveBeenCalledWith({ providerId: "minimax" });
    });

    it("saves image input when the switch is turned on", async () => {
        const user = userEvent.setup();
        const { onSaveBuiltin } = renderBuiltin();
        const row = within(modelList())
            .getByText("MiniMax-M3.1")
            .closest(".provider-detail-model-row") as HTMLElement;
        expect(within(row).queryByText("settings.providerModelImagesBadge")).toBeNull();
        await user.click(
            within(row).getByRole("button", { name: "settings.providerModelWindowEdit" }),
        );
        const sw = within(row.parentElement as HTMLElement).getByRole("switch", {
            name: "settings.providerModelImages",
        });
        expect(sw.hasAttribute("aria-label")).toBe(false);
        await user.click(sw);
        expect(within(row).getByText("settings.providerModelImagesBadge")).toBeTruthy();
        await user.click(screen.getByRole("button", { name: "settings.providerSaveKey" }));

        await waitFor(() =>
            expect(onSaveBuiltin).toHaveBeenCalledWith(
                undefined,
                [{ id: "MiniMax-M3.1", input: ["text", "image"] }],
                [],
            ),
        );
    });

    it("drops image input when the switch is turned off", async () => {
        const user = userEvent.setup();
        const withImages: ProviderView = {
            ...provider,
            models: [
                { provider: "minimax", id: "MiniMax-M2", origin: "builtin" },
                {
                    provider: "minimax",
                    id: "MiniMax-M3.1",
                    origin: "extra",
                    input: ["text", "image"],
                },
            ],
        };
        const onSaveBuiltin = vi.fn().mockResolvedValue(undefined);
        render(
            <ProviderDetailModal
                client={{ providersRevealKey: vi.fn() } as unknown as TacoClient}
                workspace={WS}
                provider={withImages}
                existingIds={[]}
                mask="sk-ant-…AbCd"
                saving={false}
                onSaveBuiltin={onSaveBuiltin}
                onClose={vi.fn()}
            />,
        );
        const row = within(modelList())
            .getByText("MiniMax-M3.1")
            .closest(".provider-detail-model-row") as HTMLElement;
        expect(within(row).getByText("settings.providerModelImagesBadge")).toBeTruthy();
        await user.click(
            within(row).getByRole("button", { name: "settings.providerModelWindowEdit" }),
        );
        await user.click(
            within(row.parentElement as HTMLElement).getByRole("switch", {
                name: "settings.providerModelImages",
            }),
        );
        await user.click(screen.getByRole("button", { name: "settings.providerSaveKey" }));

        await waitFor(() =>
            expect(onSaveBuiltin).toHaveBeenCalledWith(undefined, [{ id: "MiniMax-M3.1" }], []),
        );
    });
});

describe("ProviderDetailModal — test connection", () => {
    const provider: ProviderView = {
        id: "minimax",
        name: "MiniMax",
        configured: true,
        custom: false,
        models: [
            { provider: "minimax", id: "MiniMax-M2", origin: "builtin" },
            { provider: "minimax", id: "MiniMax-M3.1", origin: "extra" },
        ],
    };

    function renderSaved(testConnection: TacoClient["providerTestConnection"]) {
        const client = {
            providersRevealKey: vi.fn(),
            providerTestConnection: testConnection,
        } as unknown as TacoClient;
        render(
            <ProviderDetailModal
                client={client}
                workspace={WS}
                provider={provider}
                existingIds={[]}
                mask="sk-…AbCd"
                saving={false}
                onSaveBuiltin={vi.fn()}
                onClose={vi.fn()}
            />,
        );
    }

    const testButton = () =>
        screen.getByRole("button", { name: "settings.providerTestButton" }) as HTMLButtonElement;

    it("tests the first model with the stored key and shows latency + reply", async () => {
        const user = userEvent.setup();
        const testConnection = vi.fn().mockResolvedValue({
            ok: true,
            latencyMs: 321,
            model: "MiniMax-M2",
            reply: "pong",
        });
        renderSaved(testConnection as unknown as TacoClient["providerTestConnection"]);
        await user.click(testButton());

        // No apiKey field: the stored key stays server-side.
        expect(testConnection).toHaveBeenCalledWith({
            providerId: "minimax",
            modelId: "MiniMax-M2",
        });
        await waitFor(() => expect(screen.getByText("settings.providerTestOk")).toBeTruthy());
        expect(screen.getByText("MiniMax-M2 · “pong”")).toBeTruthy();
    });

    it("sends a typed-but-unsaved key along with the probe", async () => {
        const user = userEvent.setup();
        const testConnection = vi
            .fn()
            .mockResolvedValue({ ok: true, latencyMs: 1, model: "MiniMax-M2", reply: "" });
        renderSaved(testConnection as unknown as TacoClient["providerTestConnection"]);
        await user.click(screen.getByRole("button", { name: "settings.providerReplaceKey" }));
        await user.type(screen.getByPlaceholderText("settings.providerKeyPlaceholder"), "sk-new");
        await user.click(testButton());

        expect(testConnection).toHaveBeenCalledWith({
            providerId: "minimax",
            modelId: "MiniMax-M2",
            apiKey: "sk-new",
        });
    });

    it("shows the reason headline and the raw upstream message on failure", async () => {
        const user = userEvent.setup();
        const testConnection = vi.fn().mockResolvedValue({
            ok: false,
            reason: "auth",
            message: "401: invalid api key",
            latencyMs: 90,
        });
        renderSaved(testConnection as unknown as TacoClient["providerTestConnection"]);
        await user.click(testButton());

        await waitFor(() =>
            expect(screen.getByText("settings.providerTestFail_auth")).toBeTruthy(),
        );
        expect(screen.getByText("401: invalid api key")).toBeTruthy();
    });

    it("reports a thrown RPC in the same result slot", async () => {
        const user = userEvent.setup();
        const testConnection = vi
            .fn()
            .mockRejectedValue(new Error("unknown method: provider.testConnection"));
        renderSaved(testConnection as unknown as TacoClient["providerTestConnection"]);
        await user.click(testButton());

        await waitFor(() =>
            expect(screen.getByText("unknown method: provider.testConnection")).toBeTruthy(),
        );
        expect(screen.getByText("settings.providerTestFail_error")).toBeTruthy();
    });

    it("tests the unsaved create form with its literal endpoint and key", async () => {
        const user = userEvent.setup();
        const testConnection = vi
            .fn()
            .mockResolvedValue({ ok: true, latencyMs: 5, model: "m-1", reply: "pong" });
        const client = {
            providerListModels: vi.fn(),
            providerTestConnection: testConnection,
        } as unknown as TacoClient;
        render(
            <ProviderDetailModal
                client={client}
                workspace={WS}
                existingIds={[]}
                saving={false}
                onSaveCustom={vi.fn()}
                onClose={vi.fn()}
            />,
        );
        // Disabled until there is a model to test.
        expect(testButton().disabled).toBe(true);
        await fillPrerequisites(user);
        await user.type(
            screen.getByPlaceholderText("settings.providerModelAddPlaceholder"),
            "m-1{Enter}",
        );
        await user.click(testButton());

        expect(testConnection).toHaveBeenCalledWith({
            baseUrl: "https://api.example.com/v1",
            api: "chatcomplete",
            apiKey: "sk-test",
            modelId: "m-1",
        });
    });
});
