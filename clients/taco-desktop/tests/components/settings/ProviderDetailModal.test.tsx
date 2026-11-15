/**
 * ProviderDetailModal — model discovery (create-custom mode) and the
 * built-in provider key view (mask / reveal / extras management).
 *
 * The RPC methods are vi.fn(); no sidecar involved. The i18n mock returns
 * keys verbatim.
 */

import type { CustomProviderConfig, ProviderView, WorkspaceId } from "@taco-ai/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

async function clickSave(user: ReturnType<typeof userEvent.setup>) {
    const button = screen.getByRole("button", {
        name: "settings.providerSaveKey",
    }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    await user.click(button);
}

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
    it("names compound model and connection groups and describes connection requirements", () => {
        renderCreate(vi.fn());
        expect(screen.getByRole("group", { name: "settings.providerDetailModels" })).toBe(
            modelList(),
        );
        const testGroup = screen.getByRole("group", { name: "settings.providerTestTitle" });
        expect(testGroup.classList.contains("provider-detail-test-row")).toBe(true);
        expect(
            document.getElementById(testGroup.getAttribute("aria-describedby") ?? "")?.textContent,
        ).toBe("settings.providerTestNeedModel");
        expect(
            within(testGroup).getByRole("combobox", { name: "settings.providerTestModel" }),
        ).toBeTruthy();
        expect(
            within(testGroup).getByRole("button", { name: "settings.providerTestButton" }),
        ).toBeTruthy();
        expect(fetchButton().classList.contains("ui-btn--sm")).toBe(true);
        for (const label of document.querySelectorAll<HTMLLabelElement>("label[for]")) {
            expect(document.getElementById(label.htmlFor)?.tagName).not.toBe("DIV");
        }
    });

    it("describes a model discovery failure on the model group", async () => {
        const user = userEvent.setup({ delay: null });
        renderCreate(
            vi.fn().mockResolvedValue({ ok: false, reason: "http-error", message: "HTTP 401" }),
        );
        await fillPrerequisites(user);
        await user.click(fetchButton());
        await screen.findByText("HTTP 401");
        const group = screen.getByRole("group", { name: "settings.providerDetailModels" });
        expect(group.getAttribute("aria-invalid")).toBe("true");
        const ids = group.getAttribute("aria-describedby")?.split(/\s+/);
        expect(ids?.map((id) => document.getElementById(id)?.textContent)).toContain("HTTP 401");
    });

    it("puts the API feature class on the trigger and portalled list", async () => {
        const user = userEvent.setup({ delay: null });
        renderCreate(vi.fn());
        const dialog = screen.getByRole("dialog");
        const trigger = screen.getByRole("combobox", { name: "settings.customProviderApi" });
        expect(trigger.classList.contains("provider-api-select")).toBe(true);
        await user.click(trigger);
        const list = await screen.findByRole("listbox");
        expect(list.matches(".provider-api-select.ui-select-content")).toBe(true);
        expect(list.querySelectorAll(".ui-select-item").length).toBeGreaterThan(1);
        expect(dialog.contains(list)).toBe(false);
    });

    it("disables the fetch button until baseUrl and apiKey are filled", async () => {
        const user = userEvent.setup({ delay: null });
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
        const user = userEvent.setup({ delay: null });
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
        const user = userEvent.setup({ delay: null });
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
        const user = userEvent.setup({ delay: null });
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
        const user = userEvent.setup({ delay: null });
        const listModels = vi.fn().mockResolvedValue({ ok: true, models: ["dup", "dup", "other"] });
        renderCreate(listModels as unknown as ListModels);
        await fillPrerequisites(user);
        await user.click(fetchButton());

        await waitFor(() => expect(within(candidateList()).getByText("other")).toBeTruthy());
        expect(within(candidateList()).getAllByText("dup").length).toBe(1);
    });

    it("filters a late discovery response against manual edits made while it was pending", async () => {
        const user = userEvent.setup({ delay: null });
        let resolveFetch!: (result: { ok: true; models: string[] }) => void;
        renderCreate(
            vi.fn(
                () =>
                    new Promise((resolve) => {
                        resolveFetch = resolve;
                    }),
            ) as ListModels,
        );
        await fillPrerequisites(user);
        await user.click(fetchButton());
        await user.type(
            screen.getByPlaceholderText("settings.providerModelAddPlaceholder"),
            "late{Enter}",
        );
        await act(async () => resolveFetch({ ok: true, models: ["late", "late", "other"] }));
        expect(within(candidateList()).queryByText("late")).toBeNull();
        expect(within(candidateList()).getAllByText("other")).toHaveLength(1);
        await user.click(screen.getByRole("button", { name: "settings.providerModelRemove" }));
        expect(within(candidateList()).getAllByText("late")).toHaveLength(1);
        await user.click(
            within(candidateList()).getAllByRole("button", {
                name: "settings.providerModelAdd",
            })[0],
        );
        expect(within(modelList()).getAllByText("late")).toHaveLength(1);
        expect(within(candidateList()).queryByText("late")).toBeNull();
    });

    it("surfaces the message when the RPC reports a failure", async () => {
        const user = userEvent.setup({ delay: null });
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
        const user = userEvent.setup({ delay: null });
        const listModels = vi.fn().mockResolvedValue({ ok: true, models: [] });
        renderCreate(listModels as unknown as ListModels);
        await fillPrerequisites(user);
        await user.click(fetchButton());

        await waitFor(() =>
            expect(screen.getByText("settings.customProviderFetchEmpty")).toBeTruthy(),
        );
    });

    it("surfaces a thrown transport error instead of crashing", async () => {
        const user = userEvent.setup({ delay: null });
        const listModels = vi.fn().mockRejectedValue(new Error("sidecar is down"));
        renderCreate(listModels as unknown as ListModels);
        await fillPrerequisites(user);
        await user.click(fetchButton());

        await waitFor(() => expect(screen.getByText("sidecar is down")).toBeTruthy());
    });

    it("keeps the fetch button available for the response protocol", async () => {
        const user = userEvent.setup({ delay: null });
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

    it("switches the saved key group to a labelled input when replacing the key", async () => {
        const user = userEvent.setup({ delay: null });
        renderBuiltin();
        const group = screen.getByRole("group", { name: "settings.providerDetailKey" });
        expect(group.classList.contains("provider-detail-key-view")).toBe(true);
        expect(
            within(group).getByRole("button", { name: "settings.providerDetailReveal" }),
        ).toBeTruthy();
        await user.click(
            within(group).getByRole("button", { name: "settings.providerReplaceKey" }),
        );
        expect(screen.queryByRole("group", { name: "settings.providerDetailKey" })).toBeNull();
        const input = screen.getByLabelText("settings.providerDetailKey");
        expect(input.tagName).toBe("INPUT");
        expect(
            document.getElementById(input.getAttribute("aria-describedby") ?? "")?.textContent,
        ).toBe("settings.providerDetailKeepKey");
        await user.click(screen.getByText("settings.providerDetailKey"));
        expect(document.activeElement).toBe(input);
    });

    it("shows the masked key and reveals plaintext via providers.revealKey", async () => {
        const user = userEvent.setup({ delay: null });
        const revealKey = vi.fn().mockResolvedValue({ key: "sk-plain-text" });
        renderBuiltin(revealKey);

        expect(screen.getByText("sk-ant-…AbCd")).toBeTruthy();
        await user.click(screen.getByRole("button", { name: "settings.providerDetailReveal" }));

        await waitFor(() => expect(screen.getByText("sk-plain-text")).toBeTruthy());
        expect(revealKey).toHaveBeenCalledWith({ workspace: "/tmp/ws", providerId: "minimax" });
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
        const user = userEvent.setup({ delay: null });
        const { onSaveBuiltin } = renderBuiltin();
        await user.click(screen.getByRole("button", { name: "settings.providerModelRemove" }));
        await user.click(screen.getByRole("button", { name: "settings.providerModelHide" }));
        await clickSave(user);

        await waitFor(() =>
            expect(onSaveBuiltin).toHaveBeenCalledWith(undefined, [], ["MiniMax-M2"]),
        );
    });

    it("moves a hidden model out of the visible list instead of showing it twice", async () => {
        const user = userEvent.setup({ delay: null });
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
        const user = userEvent.setup({ delay: null });
        const { onSaveBuiltin } = renderBuiltin();
        await user.click(screen.getByRole("button", { name: "settings.providerModelHide" }));
        // The row moves to the removed section, tagged and struck through.
        await waitFor(() => expect(screen.getByText("settings.providerOriginHidden")).toBeTruthy());
        await user.click(screen.getByRole("button", { name: "settings.providerModelRestore" }));
        await clickSave(user);

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
        const user = userEvent.setup({ delay: null });
        const { onSaveBuiltin } = renderBuiltin();
        const windowInput = await openCustomWindowInput(user, "MiniMax-M3.1");
        await user.type(windowInput, "999999");
        await clickSave(user);

        await waitFor(() =>
            expect(onSaveBuiltin).toHaveBeenCalledWith(
                undefined,
                [{ id: "MiniMax-M3.1", contextWindow: 999999 }],
                [],
            ),
        );
    });

    it("expands k/m shorthand in the context window field", async () => {
        const user = userEvent.setup({ delay: null });
        const { onSaveBuiltin } = renderBuiltin();
        const windowInput = await openCustomWindowInput(user, "MiniMax-M3.1");
        await user.type(windowInput, "1024k");
        await clickSave(user);

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
        const user = userEvent.setup({ delay: null });
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
        await clickSave(user);

        await waitFor(() =>
            expect(onSaveBuiltin).toHaveBeenCalledWith(
                undefined,
                [{ id: "MiniMax-M3.1", contextWindow: 1000000 }],
                [],
            ),
        );
    });

    it("switching back to the default option clears the declared window", async () => {
        const user = userEvent.setup({ delay: null });
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
        await clickSave(user);

        await waitFor(() =>
            expect(onSaveBuiltin).toHaveBeenCalledWith(undefined, [{ id: "MiniMax-M3.1" }], []),
        );
    });

    it("keeps a declared display name when the provider panel is saved", async () => {
        const user = userEvent.setup({ delay: null });
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
        await clickSave(user);

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
        const user = userEvent.setup({ delay: null });
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
        const user = userEvent.setup({ delay: null });
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
        await clickSave(user);

        await waitFor(() =>
            expect(onSaveBuiltin).toHaveBeenCalledWith(
                undefined,
                [{ id: "MiniMax-M3.1", input: ["text", "image"] }],
                [],
            ),
        );
    });

    it("drops image input when the switch is turned off", async () => {
        const user = userEvent.setup({ delay: null });
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
        await clickSave(user);

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
        const user = userEvent.setup({ delay: null });
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
        const user = userEvent.setup({ delay: null });
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
        const user = userEvent.setup({ delay: null });
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
        const user = userEvent.setup({ delay: null });
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
        const user = userEvent.setup({ delay: null });
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

describe("ProviderDetailModal — save contracts", () => {
    const cfg: CustomProviderConfig = {
        id: "custom:existing",
        name: "Existing",
        api: "anthropic",
        baseUrl: "https://example.com/v1",
        models: [
            {
                id: "rich",
                name: "Rich model",
                contextWindow: 999999,
                maxTokens: 4321,
                reasoning: false,
                input: ["text", "image"],
            },
            { id: "bare" },
            { id: "empty-input", input: [] },
        ],
    };
    const provider: ProviderView = {
        id: cfg.id,
        name: cfg.name,
        custom: true,
        configured: true,
        models: [],
    };
    const saveButton = () =>
        screen.getByRole("button", {
            name: "settings.providerSaveKey",
        }) as HTMLButtonElement;

    function renderCustom(onSaveCustom = vi.fn().mockResolvedValue(undefined)) {
        return render(
            <ProviderDetailModal
                client={
                    {
                        providersRevealKey: vi.fn().mockResolvedValue({ key: "sk-revealed" }),
                    } as unknown as TacoClient
                }
                workspace={WS}
                provider={provider}
                cfg={cfg}
                existingIds={[cfg.id]}
                mask="sk-mask…1234"
                saving={false}
                onSaveCustom={onSaveCustom}
                onClose={vi.fn()}
            />,
        );
    }

    it("preserves frozen custom fields and all model metadata without sending a revealed key", async () => {
        const user = userEvent.setup({ delay: null });
        const onSave = vi.fn().mockResolvedValue(undefined);
        renderCustom(onSave);
        await user.click(screen.getByRole("button", { name: "settings.providerDetailReveal" }));
        await screen.findByText("sk-revealed");
        const endpoint = screen.getByLabelText("settings.customProviderBaseUrl");
        await user.clear(endpoint);
        await user.type(endpoint, "  https://changed.example/v1  ");
        await user.click(saveButton());
        await waitFor(() =>
            expect(onSave).toHaveBeenCalledWith(
                {
                    ...cfg,
                    baseUrl: "https://changed.example/v1",
                },
                "",
            ),
        );
        const models = onSave.mock.calls[0][0].models;
        expect(models).toStrictEqual(cfg.models);
        expect(models[1]).not.toHaveProperty("input");
        expect(models[1]).not.toHaveProperty("contextWindow");
        expect(models[2].input).toEqual([]);
    });

    it("preserves the JSON property order of unchanged built-in extras", async () => {
        const user = userEvent.setup({ delay: null });
        const onSave = vi.fn().mockResolvedValue(undefined);
        const extras = [
            {
                id: "rich",
                name: "Rich model",
                contextWindow: 999999,
                maxTokens: 4321,
                reasoning: false,
                input: [],
            },
        ];
        render(
            <ProviderDetailModal
                client={{} as TacoClient}
                workspace={WS}
                provider={{
                    ...provider,
                    id: "builtin",
                    custom: false,
                    models: extras.map((model) => ({
                        ...model,
                        provider: "builtin",
                        origin: "extra" as const,
                    })),
                }}
                existingIds={[]}
                saving={false}
                onSaveBuiltin={onSave}
                onClose={vi.fn()}
            />,
        );
        await clickSave(user);
        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
        expect(JSON.stringify(onSave.mock.calls[0][1])).toBe(JSON.stringify(extras));
    });

    it.each(["", "   ", "  sk-new  "])(
        "keeps or replaces a custom key from typed input %j",
        async (key) => {
            const user = userEvent.setup({ delay: null });
            const onSave = vi.fn().mockResolvedValue(undefined);
            renderCustom(onSave);
            await user.click(screen.getByRole("button", { name: "settings.providerReplaceKey" }));
            if (key) await user.type(screen.getByLabelText("settings.providerDetailKey"), key);
            await user.click(saveButton());
            await waitFor(() => expect(onSave).toHaveBeenCalledWith(cfg, key.trim()));
        },
    );

    it.each(["   ", "  sk-new  "])(
        "keeps or replaces a built-in key from typed input %j",
        async (key) => {
            const user = userEvent.setup({ delay: null });
            const onSave = vi.fn().mockResolvedValue(undefined);
            render(
                <ProviderDetailModal
                    client={{} as TacoClient}
                    workspace={WS}
                    provider={{
                        ...provider,
                        id: "builtin",
                        custom: false,
                        models: [
                            {
                                provider: "builtin",
                                id: "rich",
                                origin: "extra",
                                name: "Rich model",
                                contextWindow: 999999,
                                maxTokens: 4321,
                                reasoning: false,
                                input: [],
                            },
                            { provider: "builtin", id: "bare", name: "bare", origin: "extra" },
                        ],
                    }}
                    existingIds={[]}
                    saving={false}
                    onSaveBuiltin={onSave}
                    onClose={vi.fn()}
                />,
            );
            await user.click(screen.getByRole("button", { name: "settings.providerReplaceKey" }));
            await user.type(screen.getByLabelText("settings.providerDetailKey"), key);
            await user.click(saveButton());
            await waitFor(() =>
                expect(onSave).toHaveBeenCalledWith(
                    key.trim() || undefined,
                    [
                        {
                            id: "rich",
                            name: "Rich model",
                            contextWindow: 999999,
                            maxTokens: 4321,
                            reasoning: false,
                            input: [],
                        },
                        { id: "bare" },
                    ],
                    [],
                ),
            );
        },
    );

    it("updates custom validity on changes to required fields, id collisions and model removal", async () => {
        const user = userEvent.setup({ delay: null });
        const onSave = vi.fn().mockResolvedValue(undefined);
        render(
            <ProviderDetailModal
                client={{} as TacoClient}
                workspace={WS}
                existingIds={["custom:taken"]}
                saving={false}
                onSaveCustom={onSave}
                onClose={vi.fn()}
            />,
        );
        expect(saveButton().disabled).toBe(true);
        const name = screen.getByLabelText("settings.customProviderName");
        const id = screen.getByLabelText("settings.customProviderId");
        const endpoint = screen.getByLabelText("settings.customProviderBaseUrl");
        await user.type(name, "  New provider  ");
        await user.type(endpoint, "  https://new.example/v1  ");
        await user.type(
            screen.getByPlaceholderText("settings.providerModelAddPlaceholder"),
            "model{Enter}",
        );
        await waitFor(() => expect(saveButton().disabled).toBe(false));
        for (const invalidId of ["custom:taken", "wrong-prefix"]) {
            await user.clear(id);
            await user.type(id, invalidId);
            await waitFor(() => expect(saveButton().disabled).toBe(true));
        }
        await user.clear(id);
        await user.type(id, "custom:new");
        await waitFor(() => expect(saveButton().disabled).toBe(false));
        await user.clear(name);
        await user.type(name, "   ");
        await waitFor(() => expect(saveButton().disabled).toBe(true));
        await user.type(name, "New provider");
        await user.clear(endpoint);
        await waitFor(() => expect(saveButton().disabled).toBe(true));
        await user.type(endpoint, "  https://new.example/v1  ");
        await user.click(screen.getByRole("button", { name: "settings.providerModelRemove" }));
        await waitFor(() => expect(saveButton().disabled).toBe(true));
        await user.type(
            screen.getByPlaceholderText("settings.providerModelAddPlaceholder"),
            "model{Enter}",
        );
        await waitFor(() => expect(saveButton().disabled).toBe(false));
        await user.click(saveButton());
        await waitFor(() =>
            expect(onSave).toHaveBeenCalledWith(
                {
                    id: "custom:new",
                    name: "New provider",
                    api: "chatcomplete",
                    baseUrl: "https://new.example/v1",
                    models: [{ id: "model" }],
                },
                "",
            ),
        );
    });

    it("preserves a preset when selecting custom and clears only the window for invalid raw text", async () => {
        const user = userEvent.setup({ delay: null });
        const onSave = vi.fn((_cfg: CustomProviderConfig, _key: string): void => {});
        render(
            <ProviderDetailModal
                client={{} as TacoClient}
                workspace={WS}
                provider={provider}
                cfg={{ ...cfg, models: [{ ...cfg.models[0], contextWindow: 128000 }] }}
                existingIds={[]}
                saving={false}
                onSaveCustom={onSave}
                onClose={vi.fn()}
            />,
        );
        await user.click(screen.getByRole("button", { name: "settings.providerModelWindowEdit" }));
        await user.click(screen.getByRole("combobox", { name: "settings.providerModelWindow" }));
        await user.click(
            await screen.findByRole("option", { name: "settings.providerModelWindowCustom" }),
        );
        const input = screen.getByPlaceholderText("settings.providerModelWindowPlaceholder");
        expect((input as HTMLInputElement).value).toBe("128000");
        await clickSave(user);
        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
        expect(onSave.mock.calls[0][0].models).toStrictEqual([
            { ...cfg.models[0], contextWindow: 128000 },
        ]);
        await user.clear(input);
        await user.type(input, "invalid");
        await clickSave(user);
        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
        const { contextWindow: _window, ...expected } = cfg.models[0];
        expect(onSave.mock.calls[1][0].models).toStrictEqual([expected]);
    });

    it("keeps model ids and metadata aligned after removing an earlier field-array row", async () => {
        const user = userEvent.setup({ delay: null });
        const onSave = vi.fn().mockResolvedValue(undefined);
        renderCustom(onSave);
        await user.click(
            screen.getAllByRole("button", { name: "settings.providerModelRemove" })[0],
        );
        await user.click(
            screen.getAllByRole("button", { name: "settings.providerModelWindowEdit" })[0],
        );
        await user.click(screen.getByRole("switch", { name: "settings.providerModelImages" }));
        await clickSave(user);
        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
        expect(onSave.mock.calls[0][0].models).toStrictEqual([
            { id: "bare", input: ["text", "image"] },
            { id: "empty-input", input: [] },
        ]);
    });

    it("drops an explicit input declaration after toggling images on then off", async () => {
        const user = userEvent.setup({ delay: null });
        const onSave = vi.fn().mockResolvedValue(undefined);
        renderCustom(onSave);
        await user.click(
            screen.getAllByRole("button", { name: "settings.providerModelWindowEdit" })[2],
        );
        const toggle = screen.getByRole("switch", { name: "settings.providerModelImages" });
        await user.click(toggle);
        await user.click(toggle);
        await clickSave(user);
        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
        expect(onSave.mock.calls[0][0].models).toStrictEqual([
            cfg.models[0],
            cfg.models[1],
            { id: "empty-input" },
        ]);
    });

    it("blocks duplicate saves until an async callback settles even before parent saving updates", async () => {
        const user = userEvent.setup({ delay: null });
        let resolveSave!: () => void;
        const onSave = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    resolveSave = resolve;
                }),
        );
        renderCustom(onSave);
        await waitFor(() => expect(saveButton().disabled).toBe(false));
        await user.click(saveButton());
        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
        expect(saveButton().disabled).toBe(true);
        await user.click(saveButton());
        expect(onSave).toHaveBeenCalledTimes(1);
        await act(async () => resolveSave());
        await waitFor(() => expect(saveButton().disabled).toBe(false));
        await user.click(saveButton());
        expect(onSave).toHaveBeenCalledTimes(2);
        await act(async () => resolveSave());
    });

    it("serializes clicks in the same event batch and unlocks after an awaited save rejection", async () => {
        let rejectSave!: (error: Error) => void;
        const onSave = vi.fn(
            () =>
                new Promise<void>((_resolve, reject) => {
                    rejectSave = reject;
                }),
        );
        renderCustom(onSave);
        await waitFor(() => expect(saveButton().disabled).toBe(false));
        act(() => {
            fireEvent.click(saveButton());
            fireEvent.click(saveButton());
        });
        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
        expect(saveButton().disabled).toBe(true);
        await act(async () => rejectSave(new Error("save failed")));
        await waitFor(() => expect(saveButton().disabled).toBe(false));
        act(() => {
            fireEvent.click(saveButton());
            fireEvent.click(saveButton());
        });
        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
        await act(async () => rejectSave(new Error("retry failed")));
        await waitFor(() => expect(saveButton().disabled).toBe(false));
    });

    it("retains the draft after rejection and respects parent saving and error props", async () => {
        const user = userEvent.setup({ delay: null });
        const onSave = vi.fn().mockRejectedValue(new Error("save failed"));
        const { rerender } = renderCustom(onSave);
        await waitFor(() => expect(saveButton().disabled).toBe(false));
        await user.click(saveButton());
        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
        rerender(
            <ProviderDetailModal
                client={{} as TacoClient}
                workspace={WS}
                provider={provider}
                cfg={cfg}
                existingIds={[]}
                saving
                saveError="save failed"
                onSaveCustom={onSave}
                onClose={vi.fn()}
            />,
        );
        expect(screen.getByRole("alert").textContent).toBe("save failed");
        expect(saveButton().disabled).toBe(true);
        expect(screen.getByDisplayValue(cfg.baseUrl)).toBeTruthy();
    });
});
