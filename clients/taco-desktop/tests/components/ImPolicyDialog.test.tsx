/**
 * ImPolicyDialog — local rule removal (× on allow/deny rows).
 *
 * Clicking the × on a rule only mutates local React state — the user must
 * also click Save to push the patch to the server. The list must update
 * immediately to reflect the local removal.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
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

afterEach(cleanup);

describe("ImPolicyDialog — local rule removal", () => {
    it("removes the row from the list immediately when × is clicked", async () => {
        const client = {
            imPolicyGet: vi.fn(async () => ({
                channelId: "wechat",
                channelDefault: {
                    commands: { allow: ["Mmx"] },
                },
                resolved: {
                    tools: { fsTools: "deny", shell: "deny" },
                    commands: { mode: "ask" },
                },
                chatOverride: null,
                hasOverride: false,
                overrides: [],
            })),
            imPolicySetChannelDefault: vi.fn(async () => ({ channelId: "wechat" })),
            imPolicySetChatOverride: vi.fn(async () => ({ channelId: "wechat" })),
            imPolicyClearChatOverride: vi.fn(() => Promise.resolve({ channelId: "wechat" })),
        } as unknown as TacoClient;

        const user = userEvent.setup();
        render(
            <ImPolicyDialog
                open
                scope={{ channelId: "wechat" }}
                client={client}
                onClose={vi.fn()}
            />,
        );

        // Wait for the loaded allow rule to render.
        await waitFor(() => {
            expect(screen.getByText("Mmx")).toBeDefined();
        });

        const removeButtons = screen.getAllByLabelText("imPolicy.removeRule");
        expect(removeButtons.length).toBeGreaterThan(0);
        const [firstRemove] = removeButtons;
        if (!firstRemove) throw new Error("expected at least one remove button");
        await user.click(firstRemove);

        // The row must disappear from the DOM immediately.
        await waitFor(() => {
            expect(screen.queryByText("Mmx")).toBeNull();
        });

        // And it must STAY gone across another render cycle — not come back.
        // User reported "click × but the rule is still there", which suggests
        // something is re-mounting the row from a stale cache.
        await new Promise((r) => setTimeout(r, 50));
        expect(screen.queryByText("Mmx")).toBeNull();
    });

    it("a freshly added rule is removed by × before save (local-only)", async () => {
        const client = {
            imPolicyGet: vi.fn(async () => ({
                channelId: "wechat",
                channelDefault: { commands: { allow: [] } },
                resolved: {
                    tools: { fsTools: "deny", shell: "deny" },
                    commands: { mode: "ask" },
                },
                chatOverride: null,
                hasOverride: false,
                overrides: [],
            })),
            imPolicySetChannelDefault: vi.fn(async () => ({ channelId: "wechat" })),
            imPolicySetChatOverride: vi.fn(async () => ({ channelId: "wechat" })),
            imPolicyClearChatOverride: vi.fn(() => Promise.resolve({ channelId: "wechat" })),
        } as unknown as TacoClient;

        const user = userEvent.setup();
        render(
            <ImPolicyDialog
                open
                scope={{ channelId: "wechat" }}
                client={client}
                onClose={vi.fn()}
            />,
        );

        // Wait for empty list to settle.
        await waitFor(() => {
            expect(screen.getByText("imPolicy.noRules")).toBeDefined();
        });

        // Add a rule.
        const input = screen.getByPlaceholderText("imPolicy.rulePlaceholder") as HTMLInputElement;
        await user.type(input, "ls");
        await user.click(screen.getByText("imPolicy.addRule"));

        await waitFor(() => {
            expect(screen.getByText("ls")).toBeDefined();
        });

        // Remove it.
        const removeButtons = screen.getAllByLabelText("imPolicy.removeRule");
        expect(removeButtons.length).toBeGreaterThan(0);
        const [firstRemove] = removeButtons;
        if (!firstRemove) throw new Error("expected at least one remove button");
        await user.click(firstRemove);

        await waitFor(() => {
            expect(screen.queryByText("ls")).toBeNull();
        });
        expect(screen.getByText("imPolicy.noRules")).toBeDefined();
    });

    it("regression: removing a rule that came from the server stays gone after re-render (effect does not re-fire)", async () => {
        const client = {
            imPolicyGet: vi.fn(async () => ({
                channelId: "wechat",
                channelDefault: { commands: { allow: ["Mmx", "ls"] } },
                resolved: {
                    tools: { fsTools: "deny", shell: "deny" },
                    commands: { mode: "ask" },
                },
                chatOverride: null,
                hasOverride: false,
                overrides: [],
            })),
            imPolicySetChannelDefault: vi.fn(async () => ({ channelId: "wechat" })),
            imPolicySetChatOverride: vi.fn(async () => ({ channelId: "wechat" })),
            imPolicyClearChatOverride: vi.fn(() => Promise.resolve({ channelId: "wechat" })),
        } as unknown as TacoClient;

        const user = userEvent.setup();
        const { rerender } = render(
            <ImPolicyDialog
                open
                scope={{ channelId: "wechat" }}
                client={client}
                onClose={vi.fn()}
            />,
        );

        await waitFor(() => {
            expect(screen.getByText("Mmx")).toBeDefined();
            expect(screen.getByText("ls")).toBeDefined();
        });

        // Click × on Mmx.
        const removeButtons = screen.getAllByLabelText("imPolicy.removeRule");
        expect(removeButtons.length).toBeGreaterThan(0);
        const [firstRemove] = removeButtons;
        if (!firstRemove) throw new Error("expected at least one remove button");
        await user.click(firstRemove);

        await waitFor(() => {
            expect(screen.queryByText("Mmx")).toBeNull();
        });
        expect(screen.queryByText("ls")).toBeDefined();

        // Force a re-render with a brand-new `scope` object reference. This is
        // what ChannelsPane does on each render. The effect deps should not flip,
        // so Mmx must NOT reappear.
        rerender(
            <ImPolicyDialog
                open
                scope={{ channelId: "wechat" }}
                client={client}
                onClose={vi.fn()}
            />,
        );
        expect(screen.queryByText("Mmx")).toBeNull();
        expect(screen.queryByText("ls")).toBeDefined();
    });

    it("regression: a server reload mid-dialog does NOT clobber a freshly-edited allow list", async () => {
        // User report: "clicking × deletes then flashes back" — the rule momentarily disappears,
        // then a push reload (or an over-eager effect) overwrites the local state with
        // the server's stale list and the row comes back.
        //
        // Simulate a push-driven re-load: imPolicyGet returns ["Mmx"] on every
        // call. If a stale server reload overwrote local edits, Mmx would come
        // back after the second load.
        const client = {
            imPolicyGet: vi.fn(async () => ({
                channelId: "wechat",
                channelDefault: { commands: { allow: ["Mmx"] } },
                resolved: {
                    tools: { fsTools: "deny", shell: "deny" },
                    commands: { mode: "ask" },
                },
                chatOverride: null,
                hasOverride: false,
                overrides: [],
            })),
            imPolicySetChannelDefault: vi.fn(async () => ({ channelId: "wechat" })),
            imPolicySetChatOverride: vi.fn(async () => ({ channelId: "wechat" })),
            imPolicyClearChatOverride: vi.fn(() => Promise.resolve({ channelId: "wechat" })),
        } as unknown as TacoClient;

        const user = userEvent.setup();
        const { rerender } = render(
            <ImPolicyDialog
                open
                scope={{ channelId: "wechat" }}
                client={client}
                onClose={vi.fn()}
            />,
        );

        await waitFor(() => {
            expect(screen.getByText("Mmx")).toBeDefined();
        });
        expect((client.imPolicyGet as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);

        // User clicks ×.
        const removeButtons = screen.getAllByLabelText("imPolicy.removeRule");
        expect(removeButtons.length).toBeGreaterThan(0);
        const [firstRemove] = removeButtons;
        if (!firstRemove) throw new Error("expected at least one remove button");
        await user.click(firstRemove);
        await waitFor(() => {
            expect(screen.queryByText("Mmx")).toBeNull();
        });

        // Now simulate a push event triggering a reload, returning the same
        // server state (Mmx still there, since user hasn't saved).
        const { subscribeImPolicyChanged, onImPolicyChangedEvent } = await import(
            "../../src/lib/imPolicyEvents"
        );
        // Subscribe (the dialog already has a subscription — just dispatch).
        onImPolicyChangedEvent("wechat");

        // The hook's onImPolicyChanged will fire another imPolicyGet. Let it settle.
        await waitFor(() => {
            expect((client.imPolicyGet as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
        });

        // The user's local edit (Mmx deleted) must NOT be clobbered by the stale
        // server reload.
        expect(screen.queryByText("Mmx")).toBeNull();
        // Subscriber cleanup.
        subscribeImPolicyChanged(() => undefined);
        void rerender;
    });
});
