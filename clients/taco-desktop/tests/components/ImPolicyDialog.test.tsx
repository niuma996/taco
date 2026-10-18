/**
 * ImPolicyDialog — state cards, local rule edits, and save patches.
 *
 * Rule edits only mutate local React state until Save. The dialog must show
 * the effective value plus its source, and "restore" must clear the field at
 * the current layer instead of copying the parent value.
 */

import type { ImPolicyGetResult } from "@taco-ai/protocol";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ImPolicyDialog } from "../../src/components/ImPolicyDialog";
import type { TacoClient } from "../../src/lib/clients/tacoClient.ts";

vi.mock("react-i18next", () => ({
    useTranslation: vi.fn(() => ({
        t: (key: string) => key,
        i18n: { language: "en" },
    })),
}));

afterEach(() => {
    cleanup();
    // Radix locks body pointer events while a modal/select is open; clearing it
    // here keeps the next test's user-event clicks working.
    document.body.style.pointerEvents = "";
});

const DEFAULT_SOURCES: ImPolicyGetResult["sources"] = {
    fsTools: { value: "deny", source: "default" },
    shell: { value: "deny", source: "default" },
    commandMode: { value: "ask", source: "default" },
    perChatScratch: { value: false, source: "default" },
    executionCwd: { value: undefined, source: "default" },
};

function makeResult(overrides: Partial<ImPolicyGetResult> = {}): ImPolicyGetResult {
    return {
        channelId: "wechat",
        scope: "channel",
        channelDefault: {},
        resolved: {
            tools: { fsTools: "deny", shell: "deny" },
            commands: { mode: "ask" },
        },
        chatOverride: null,
        hasOverride: false,
        overrides: [],
        sources: DEFAULT_SOURCES,
        rules: { allow: [], deny: [] },
        ...overrides,
    };
}

/** A global rule group marks the panel as loaded — it only comes from the server. */
const GLOBAL_RULES: ImPolicyGetResult["rules"] = {
    allow: [{ source: "global", rules: ["git push"], editable: false }],
    deny: [],
};

function makeClient(result: ImPolicyGetResult): TacoClient {
    return {
        imPolicyGet: vi.fn(async () => result),
        imPolicySetChannelDefault: vi.fn(async () => ({ channelId: "wechat" })),
        imPolicySetChatOverride: vi.fn(async () => ({ channelId: "wechat" })),
        imPolicyClearChatOverride: vi.fn(async () => ({ channelId: "wechat" })),
    } as unknown as TacoClient;
}

function renderDialog(client: TacoClient, scope = { channelId: "wechat" }) {
    return render(<ImPolicyDialog open scope={scope} client={client} onClose={vi.fn()} />);
}

describe("ImPolicyDialog — effective values and sources", () => {
    it("shows the resolved value and its source instead of a raw enum", async () => {
        renderDialog(makeClient(makeResult()));
        await waitFor(() => {
            expect(screen.getAllByText("imPolicy.sourceLine").length).toBeGreaterThan(0);
        });
        expect(screen.getAllByText("imPolicy.following").length).toBeGreaterThan(0);
        expect(screen.queryByText("ask")).toBeNull();
        expect(screen.queryByText("deny")).toBeNull();
    });

    it("offers a separate override action for the channel scope", async () => {
        renderDialog(makeClient(makeResult()));
        expect((await screen.findAllByText("imPolicy.setForChannel")).length).toBeGreaterThan(0);
    });
});

describe("ImPolicyDialog — saving overrides", () => {
    it("sends the chosen value when a field is overridden", async () => {
        const client = makeClient(makeResult({ rules: GLOBAL_RULES }));
        renderDialog(client);
        const user = userEvent.setup({ pointerEventsCheck: 0 });

        // The global rule group only renders once the policy has loaded.
        await screen.findByText("imPolicy.sourceGlobal");
        const card = screen.getByRole("group", { name: "imPolicy.commandMode" });
        await user.click(within(card).getByText("imPolicy.setForChannel"));

        await user.click(within(card).getByRole("combobox"));
        await user.click(await screen.findByRole("option", { name: "imPolicy.auto" }));

        const saveButtons = screen.getAllByText("imPolicy.save");
        await user.click(saveButtons[0] as HTMLElement);
        const confirmButtons = screen.getAllByText("imPolicy.save");
        await user.click(confirmButtons[confirmButtons.length - 1] as HTMLElement);

        await waitFor(() => {
            expect(client.imPolicySetChannelDefault).toHaveBeenCalledWith({
                channelId: "wechat",
                patch: { commands: { mode: "auto" } },
            });
        });
    });

    it("sends null when a field is restored to follow the parent", async () => {
        const client = makeClient(
            makeResult({
                channelDefault: { commands: { mode: "auto" } },
                sources: {
                    ...DEFAULT_SOURCES,
                    commandMode: { value: "auto", source: "channel" },
                },
                rules: GLOBAL_RULES,
            }),
        );
        renderDialog(client);
        const user = userEvent.setup({ pointerEventsCheck: 0 });

        // The global rule group only renders once the policy has loaded.
        await screen.findByText("imPolicy.sourceGlobal");
        const card = screen.getByRole("group", { name: "imPolicy.commandMode" });
        await user.click(within(card).getByText("imPolicy.resetToParent"));

        const saveButtons = screen.getAllByText("imPolicy.save");
        await user.click(saveButtons[0] as HTMLElement);
        const confirmButtons = screen.getAllByText("imPolicy.save");
        await user.click(confirmButtons[confirmButtons.length - 1] as HTMLElement);

        await waitFor(() => {
            expect(client.imPolicySetChannelDefault).toHaveBeenCalledWith({
                channelId: "wechat",
                patch: { commands: { mode: null } },
            });
        });
    });
});

describe("ImPolicyDialog — local rule removal", () => {
    it("removes the row from the list immediately when × is clicked", async () => {
        const client = makeClient(makeResult({ channelDefault: { commands: { allow: ["Mmx"] } } }));
        renderDialog(client);

        await waitFor(() => {
            expect(screen.getByText("Mmx")).toBeDefined();
        });

        const user = userEvent.setup({ pointerEventsCheck: 0 });
        await user.click(screen.getAllByLabelText("imPolicy.removeRule")[0] as HTMLElement);

        await waitFor(() => {
            expect(screen.queryByText("Mmx")).toBeNull();
        });
        await new Promise((r) => setTimeout(r, 50));
        expect(screen.queryByText("Mmx")).toBeNull();
    });

    it("renders parent rules read-only and only allows removing local rules", async () => {
        const client = makeClient(
            makeResult({
                channelDefault: { commands: { allow: ["ls"] } },
                rules: {
                    allow: [
                        { source: "global", rules: ["git push"], editable: false },
                        { source: "channel", rules: ["ls"], editable: true },
                    ],
                    deny: [],
                },
            }),
        );
        renderDialog(client);

        await waitFor(() => {
            expect(screen.getByText("git push")).toBeDefined();
            expect(screen.getByText("ls")).toBeDefined();
        });
        expect(screen.getAllByLabelText("imPolicy.removeRule")).toHaveLength(1);
    });

    it("a freshly added rule is removed by × before save (local-only)", async () => {
        renderDialog(makeClient(makeResult()));
        const user = userEvent.setup({ pointerEventsCheck: 0 });

        const input = (await screen.findAllByPlaceholderText("imPolicy.rulePlaceholder"))[0];
        if (!input) throw new Error("expected an allow-rule input");
        await user.type(input, "ls");
        await user.click(screen.getAllByText("imPolicy.addRule")[0] as HTMLElement);
        await waitFor(() => {
            expect(screen.getByText("ls")).toBeDefined();
        });

        await user.click(screen.getAllByLabelText("imPolicy.removeRule")[0] as HTMLElement);
        await waitFor(() => {
            expect(screen.queryByText("ls")).toBeNull();
        });
    });

    it("a server reload mid-dialog does NOT clobber a freshly-edited allow list", async () => {
        const client = makeClient(makeResult({ channelDefault: { commands: { allow: ["Mmx"] } } }));
        renderDialog(client);

        await waitFor(() => {
            expect(screen.getByText("Mmx")).toBeDefined();
        });
        expect((client.imPolicyGet as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);

        const user = userEvent.setup({ pointerEventsCheck: 0 });
        await user.click(screen.getAllByLabelText("imPolicy.removeRule")[0] as HTMLElement);
        await waitFor(() => {
            expect(screen.queryByText("Mmx")).toBeNull();
        });

        const { onImPolicyChangedEvent } = await import("../../src/lib/imPolicyEvents");
        onImPolicyChangedEvent("wechat");

        await waitFor(() => {
            expect((client.imPolicyGet as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
        });
        expect(screen.queryByText("Mmx")).toBeNull();
    });
});

describe("ImPolicyDialog — blacklist wrapper rules", () => {
    it("accepts a shell wrapper in the blacklist", async () => {
        renderDialog(makeClient(makeResult({ channelDefault: { commands: { deny: [] } } })));
        const inputs = await screen.findAllByPlaceholderText("imPolicy.rulePlaceholder");
        const user = userEvent.setup({ pointerEventsCheck: 0 });
        await user.type(inputs[1] as HTMLElement, "bash *");
        await user.click(screen.getAllByText("imPolicy.addRule")[1] as HTMLElement);
        expect(screen.getByText("bash *")).toBeTruthy();
    });
});
