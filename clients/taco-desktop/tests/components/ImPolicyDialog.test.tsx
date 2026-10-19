/**
 * ImPolicyDialog — state cards, local rule edits, and save patches.
 *
 * Rule edits only mutate local React state until Save. Each single-value
 * field is one dropdown that tags the parent's value; picking that tagged
 * option must clear the field at the current layer instead of copying it.
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
    fsTools: { value: "deny", source: "default", inherited: { value: "deny", source: "default" } },
    shell: { value: "deny", source: "default", inherited: { value: "deny", source: "default" } },
    commandMode: {
        value: "ask",
        source: "default",
        inherited: { value: "ask", source: "default" },
    },
    executionDir: {
        value: { mode: "shared" },
        source: "default",
        inherited: { value: { mode: "shared" }, source: "default" },
    },
};

/** Opens a field's dropdown and picks an option by its accessible name. */
async function choose(
    user: ReturnType<typeof userEvent.setup>,
    field: string,
    option: RegExp | string,
): Promise<void> {
    const card = screen.getByRole("group", { name: field });
    await user.click(within(card).getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: option }));
}

async function saveAndConfirm(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    const saveButtons = screen.getAllByText("imPolicy.save");
    await user.click(saveButtons[0] as HTMLElement);
    const confirmButtons = screen.getAllByText("imPolicy.save");
    await user.click(confirmButtons[confirmButtons.length - 1] as HTMLElement);
}

function makeResult(overrides: Partial<ImPolicyGetResult> = {}): ImPolicyGetResult {
    return {
        channelId: "wechat",
        scope: "channel",
        channelDefault: {},
        resolved: {
            tools: { fsTools: "deny", shell: "deny" },
            commands: { mode: "ask" },
            executionDir: { mode: "shared" },
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

function renderDialog(
    client: TacoClient,
    scope: { channelId: string; peerId?: string; chatId?: string } = { channelId: "wechat" },
) {
    return render(<ImPolicyDialog open scope={scope} client={client} onClose={vi.fn()} />);
}

describe("ImPolicyDialog — one dropdown per field", () => {
    it("shows the effective value in the trigger instead of a raw enum", async () => {
        renderDialog(makeClient(makeResult()));
        const card = await screen.findByRole("group", { name: "imPolicy.commandMode" });
        await waitFor(() => {
            expect(within(card).getByRole("combobox").textContent).toContain("imPolicy.ask");
        });
        expect(screen.queryByText("ask")).toBeNull();
        expect(screen.queryByText("deny")).toBeNull();
    });

    it("tags the parent's option with the layer it comes from", async () => {
        renderDialog(makeClient(makeResult({ rules: GLOBAL_RULES })));
        await screen.findByText("imPolicy.sourceGlobal");
        const user = userEvent.setup({ pointerEventsCheck: 0 });
        const card = screen.getByRole("group", { name: "imPolicy.commandMode" });
        await user.click(within(card).getByRole("combobox"));

        const ask = await screen.findByRole("option", { name: /imPolicy\.ask/ });
        const auto = screen.getByRole("option", { name: /imPolicy\.auto/ });
        expect(ask.textContent).toContain("imPolicy.sourceDefault");
        expect(auto.textContent).not.toContain("imPolicy.sourceDefault");
    });

    it("tags the channel layer when editing a chat that inherits from it", async () => {
        renderDialog(
            makeClient(
                makeResult({
                    scope: "chat",
                    sources: {
                        ...DEFAULT_SOURCES,
                        shell: {
                            value: "allow",
                            source: "channel",
                            inherited: { value: "allow", source: "channel" },
                        },
                    },
                }),
            ),
            { channelId: "wechat", peerId: "peer-1", chatId: "chat-1" },
        );
        const card = await screen.findByRole("group", { name: "imPolicy.shell" });
        await waitFor(() => {
            const trigger = within(card).getByRole("combobox");
            expect(trigger.textContent).toContain("imPolicy.allow");
            expect(trigger.textContent).toContain("imPolicy.sourceChannel");
        });
    });
});

describe("ImPolicyDialog — saving overrides", () => {
    it("sends the chosen value when a non-parent option is picked", async () => {
        const client = makeClient(makeResult({ rules: GLOBAL_RULES }));
        renderDialog(client);
        const user = userEvent.setup({ pointerEventsCheck: 0 });

        // The global rule group only renders once the policy has loaded.
        await screen.findByText("imPolicy.sourceGlobal");
        await choose(user, "imPolicy.commandMode", /imPolicy\.auto/);
        await saveAndConfirm(user);

        await waitFor(() => {
            expect(client.imPolicySetChannelDefault).toHaveBeenCalledWith({
                channelId: "wechat",
                patch: { commands: { mode: "auto" } },
            });
        });
    });

    it("sends null when the parent's option is picked", async () => {
        const client = makeClient(
            makeResult({
                channelDefault: { commands: { mode: "auto" } },
                sources: {
                    ...DEFAULT_SOURCES,
                    commandMode: {
                        value: "auto",
                        source: "channel",
                        inherited: { value: "ask", source: "default" },
                    },
                },
                rules: GLOBAL_RULES,
            }),
        );
        renderDialog(client);
        const user = userEvent.setup({ pointerEventsCheck: 0 });

        await screen.findByText("imPolicy.sourceGlobal");
        await choose(user, "imPolicy.commandMode", /imPolicy\.ask/);
        await saveAndConfirm(user);

        await waitFor(() => {
            expect(client.imPolicySetChannelDefault).toHaveBeenCalledWith({
                channelId: "wechat",
                patch: { commands: { mode: null } },
            });
        });
    });
});

describe("ImPolicyDialog — working directory", () => {
    it("shows the effective working directory in the trigger", async () => {
        renderDialog(
            makeClient(
                makeResult({
                    channelDefault: { executionDir: { mode: "per-chat" } },
                    sources: {
                        ...DEFAULT_SOURCES,
                        executionDir: {
                            value: { mode: "per-chat" },
                            source: "channel",
                            inherited: { value: { mode: "shared" }, source: "default" },
                        },
                    },
                }),
            ),
        );
        const card = await screen.findByRole("group", { name: "imPolicy.executionCwd" });
        await waitFor(() => {
            expect(within(card).getByRole("combobox").textContent).toContain(
                "imPolicy.executionDirPerChat",
            );
        });
    });

    it("sends the chosen working directory", async () => {
        const client = makeClient(makeResult({ rules: GLOBAL_RULES }));
        renderDialog(client);
        const user = userEvent.setup({ pointerEventsCheck: 0 });

        await screen.findByText("imPolicy.sourceGlobal");
        await choose(user, "imPolicy.executionCwd", /imPolicy\.executionDirPerChat/);
        await saveAndConfirm(user);

        await waitFor(() => {
            expect(client.imPolicySetChannelDefault).toHaveBeenCalledWith({
                channelId: "wechat",
                patch: { executionDir: { mode: "per-chat" } },
            });
        });
    });

    it("sends null when the parent's working directory is picked", async () => {
        const client = makeClient(
            makeResult({
                channelDefault: { executionDir: { mode: "per-chat" } },
                sources: {
                    ...DEFAULT_SOURCES,
                    executionDir: {
                        value: { mode: "per-chat" },
                        source: "channel",
                        inherited: { value: { mode: "shared" }, source: "default" },
                    },
                },
                rules: GLOBAL_RULES,
            }),
        );
        renderDialog(client);
        const user = userEvent.setup({ pointerEventsCheck: 0 });

        await screen.findByText("imPolicy.sourceGlobal");
        await choose(user, "imPolicy.executionCwd", /imPolicy\.executionDirShared/);
        await saveAndConfirm(user);

        await waitFor(() => {
            expect(client.imPolicySetChannelDefault).toHaveBeenCalledWith({
                channelId: "wechat",
                patch: { executionDir: null },
            });
        });
    });
});

// A sidecar built before `inherited` existed sends the bare { value, source }
// shape. The dialog must still open, and must not tag this layer's own
// override as the parent's value.
describe("ImPolicyDialog — sidecar without inherited sources", () => {
    const legacySources = {
        fsTools: { value: "deny", source: "default" },
        shell: { value: "allow", source: "channel" },
        commandMode: { value: "ask", source: "default" },
        executionDir: { value: { mode: "shared" }, source: "default" },
    } as unknown as ImPolicyGetResult["sources"];

    it("opens and shows the effective values", async () => {
        renderDialog(
            makeClient(
                makeResult({
                    channelDefault: { tools: { shell: "allow" } },
                    sources: legacySources,
                }),
            ),
        );
        const card = await screen.findByRole("group", { name: "imPolicy.shell" });
        await waitFor(() => {
            expect(within(card).getByRole("combobox").textContent).toContain("imPolicy.allow");
        });
    });

    it("tags the built-in default, not this layer's override", async () => {
        renderDialog(
            makeClient(
                makeResult({
                    channelDefault: { tools: { shell: "allow" } },
                    sources: legacySources,
                    rules: GLOBAL_RULES,
                }),
            ),
        );
        await screen.findByText("imPolicy.sourceGlobal");
        const user = userEvent.setup({ pointerEventsCheck: 0 });
        const card = screen.getByRole("group", { name: "imPolicy.shell" });
        await user.click(within(card).getByRole("combobox"));

        const deny = await screen.findByRole("option", { name: /imPolicy\.deny/ });
        const allow = screen.getByRole("option", { name: /imPolicy\.allow/ });
        expect(deny.textContent).toContain("imPolicy.sourceDefault");
        expect(allow.textContent).not.toContain("imPolicy.source");
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
