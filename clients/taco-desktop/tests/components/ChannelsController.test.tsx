import type { ChannelStatusEntry } from "@taco-ai/protocol";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelBindDialogProps } from "../../src/components/ChannelBindDialog";
import { ConfigurationChannelsController } from "../../src/components/configuration/ConfigurationChannelsController";
import { onChannelStatusChangedEvent } from "../../src/lib/channelEvents";
import type { TacoClient } from "../../src/lib/clients/tacoClient";
import type { ChannelsPaneProps } from "../../src/views/ChannelsPane";

vi.mock("../../src/views/ChannelsPane", () => ({
    ChannelsPane: (props: ChannelsPaneProps) => (
        <div data-testid="channels-view">
            <button type="button" onClick={() => props.onBind("wechat")}>
                bind-wechat
            </button>
            <button type="button" onClick={() => props.onRebind("wecom")}>
                rebind-wecom
            </button>
        </div>
    ),
}));

vi.mock("../../src/components/ChannelBindDialog", () => ({
    ChannelBindDialog: (props: ChannelBindDialogProps) =>
        props.open ? (
            <div data-testid="bind-dialog" data-request-id={props.channel?.requestId}>
                <button type="button" onClick={props.onCancel}>
                    cancel-bind
                </button>
                <button
                    type="button"
                    onClick={() => props.onBindCreds({ botId: "bot", secret: "secret" })}
                >
                    submit-creds
                </button>
                <button
                    type="button"
                    onClick={() => void props.onSubmitVerifyCode("request-2", "1234")}
                >
                    submit-code
                </button>
            </div>
        ) : null,
}));

afterEach(cleanup);

const configured: ChannelStatusEntry[] = [
    { channelId: "wechat", name: "wechat", state: "unbound", configured: false },
    { channelId: "wecom", name: "wecom", state: "connected", configured: true },
];

// The controller suite stubs the dialog out; the dialog suite needs the real
// component, so it is pulled past the mock.
const { ChannelBindDialog: RealChannelBindDialog } = await vi.importActual<
    typeof import("../../src/components/ChannelBindDialog")
>("../../src/components/ChannelBindDialog");

function setupBindDialog(channel: ChannelStatusEntry) {
    const onSubmitVerifyCode = vi.fn(async () => true);
    const onBindCreds = vi.fn();
    render(
        <RealChannelBindDialog
            open
            channel={channel}
            onSubmitVerifyCode={onSubmitVerifyCode}
            onBindCreds={onBindCreds}
            onCancel={vi.fn()}
        />,
    );
    return { onSubmitVerifyCode, onBindCreds };
}

describe("ChannelBindDialog", () => {
    it("submits a verification code from the pinned footer and with Enter", async () => {
        const user = userEvent.setup();
        const { onSubmitVerifyCode } = setupBindDialog({
            channelId: "test",
            name: "test",
            state: "awaiting_verify_code",
            configured: false,
            requestId: "request-1",
        });
        const button = screen.getByRole("button", { name: "channels.submitCode" });
        expect(button.closest(".ui-modal-body")).toBeNull();
        expect((button as HTMLButtonElement).disabled).toBe(true);
        const input = screen.getByRole("textbox");
        await user.type(input, "1234");
        await user.click(button);
        expect(onSubmitVerifyCode).toHaveBeenLastCalledWith("request-1", "1234");
        await user.click(input);
        await user.keyboard("{Enter}");
        expect(onSubmitVerifyCode).toHaveBeenCalledTimes(2);
    });

    it("shows one footer for credentials and submits the associated form", async () => {
        const user = userEvent.setup();
        const { onBindCreds } = setupBindDialog({
            channelId: "wecom",
            name: "wecom",
            state: "unbound",
            configured: false,
        });
        expect(document.querySelectorAll(".ui-modal-actions")).toHaveLength(1);
        const button = screen.getByRole("button", { name: "channels.connect" });
        expect(button.closest(".ui-modal-body")).toBeNull();
        await user.type(screen.getByRole("textbox", { name: "channels.wecomBotId" }), "bot");
        await user.type(screen.getByLabelText("channels.wecomSecret"), "secret");
        await user.click(button);
        expect(onBindCreds).toHaveBeenCalledWith({ botId: "bot", secret: "secret" });
    });
});

describe("ConfigurationChannelsController", () => {
    it("owns bind, credentials, verification and hidden status pushes", async () => {
        const channelsList = vi.fn(async () => ({
            available: [],
            configured,
            failed: [],
        }));
        const channelsBind = vi.fn(async () => ({ state: "connecting" }));
        const channelsSubmitVerifyCode = vi.fn(async () => ({ accepted: true }));
        const client = {
            channelsList,
            channelsBind,
            channelsSubmitVerifyCode,
        } as unknown as TacoClient;
        const props = {
            active: true,
            client,
            activeCwd: "/repo-a",
            restartSidecar: vi.fn(async () => {}),
            conversations: [],
            conversationsLoading: false,
            conversationsError: null,
            conversationsUnread: 0,
            markConversationsSeen: vi.fn(),
            onOpenConversation: vi.fn(),
        };
        const view = render(<ConfigurationChannelsController {...props} />);
        await waitFor(() => expect(channelsList).toHaveBeenCalledTimes(1));

        fireEvent.click(screen.getByRole("button", { name: "bind-wechat" }));
        await waitFor(() =>
            expect(channelsBind).toHaveBeenCalledWith({
                channelId: "wechat",
                force: undefined,
                creds: undefined,
            }),
        );
        expect(screen.getByTestId("bind-dialog")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "cancel-bind" }));

        fireEvent.click(screen.getByRole("button", { name: "rebind-wecom" }));
        expect(channelsBind).toHaveBeenCalledTimes(1);
        fireEvent.click(screen.getByRole("button", { name: "submit-creds" }));
        await waitFor(() =>
            expect(channelsBind).toHaveBeenLastCalledWith({
                channelId: "wecom",
                force: true,
                creds: { botId: "bot", secret: "secret" },
            }),
        );

        view.rerender(<ConfigurationChannelsController {...props} active={false} />);
        expect(screen.queryByTestId("channels-view")).toBeNull();
        expect(screen.getByTestId("bind-dialog")).toBeTruthy();
        onChannelStatusChangedEvent({
            channelId: "wecom",
            name: "wecom",
            state: "awaiting_verify_code",
            configured: true,
            requestId: "request-2",
        });
        await waitFor(() =>
            expect(screen.getByTestId("bind-dialog").getAttribute("data-request-id")).toBe(
                "request-2",
            ),
        );
        fireEvent.click(screen.getByRole("button", { name: "submit-code" }));
        await waitFor(() =>
            expect(channelsSubmitVerifyCode).toHaveBeenCalledWith({
                requestId: "request-2",
                code: "1234",
            }),
        );
    });
});
