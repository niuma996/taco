import type { ChannelStatusEntry } from "@taco-ai/protocol";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ChannelBindDialog } from "../../src/components/ChannelBindDialog";

vi.mock("react-i18next", () => ({
    useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

afterEach(cleanup);

function setup(channel: ChannelStatusEntry) {
    const onSubmitVerifyCode = vi.fn(async () => true);
    const onBindCreds = vi.fn();
    render(
        <ChannelBindDialog
            open
            channel={channel}
            onSubmitVerifyCode={onSubmitVerifyCode}
            onBindCreds={onBindCreds}
            onCancel={vi.fn()}
        />,
    );
    return { onSubmitVerifyCode, onBindCreds };
}

it("submits a verification code from the pinned footer and with Enter", async () => {
    const user = userEvent.setup();
    const { onSubmitVerifyCode } = setup({
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
    const { onBindCreds } = setup({
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
