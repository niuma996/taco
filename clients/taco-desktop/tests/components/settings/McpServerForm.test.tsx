import type { McpServerConfig } from "@taco-ai/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServerForm } from "../../../src/components/settings/McpServerForm";

vi.mock("react-i18next", () => ({
    useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
afterEach(cleanup);
const existing: McpServerConfig = {
    id: "secret-server",
    transport: "stdio",
    command: "node",
    args: ["--flag", "value"],
    env: { TOKEN: "secret=with=equals", EMPTY: "" },
    cwd: "/work",
    timeoutMs: 15000,
    alwaysLoaded: ["search"],
};
function mount(config = existing, onSave = vi.fn()) {
    render(
        <McpServerForm
            existing={config}
            existingIds={[config.id]}
            onSave={onSave}
            onCancel={vi.fn()}
        />,
    );
    return onSave;
}
const saveButton = () => screen.getByRole("button", { name: "settings.mcpServerSave" });

describe("MCP form payload and lifecycle", () => {
    it("keeps immutable id, secret values and explicit empty env values on edit", async () => {
        const onSave = mount();
        await waitFor(() => expect(saveButton().hasAttribute("disabled")).toBe(false));
        await userEvent.click(saveButton());
        await waitFor(() =>
            expect(onSave).toHaveBeenCalledWith({
                ...existing,
                url: undefined,
                headers: undefined,
            }),
        );
    });
    it("retains hidden transport drafts but omits inactive transport fields", async () => {
        const user = userEvent.setup({ delay: null });
        const onSave = mount();
        await user.click(screen.getByRole("combobox", { name: "settings.mcpServerTransport" }));
        await user.click(screen.getByRole("option", { name: "settings.mcpServerTransportHttp" }));
        fireEvent.change(screen.getByLabelText("settings.mcpServerUrl"), {
            target: { value: "https://example.com/mcp" },
        });
        fireEvent.change(screen.getByLabelText("settings.mcpServerHeaders"), {
            target: { value: "Authorization: Bearer secret:token\nX-Empty:" },
        });
        await waitFor(() => expect(saveButton().hasAttribute("disabled")).toBe(false));
        await user.click(saveButton());
        await waitFor(() =>
            expect(onSave).toHaveBeenCalledWith(
                expect.objectContaining({
                    id: existing.id,
                    transport: "http",
                    command: undefined,
                    args: undefined,
                    env: undefined,
                    cwd: undefined,
                    url: "https://example.com/mcp",
                    headers: { Authorization: "Bearer secret:token", "X-Empty": "" },
                }),
            ),
        );
        await user.click(screen.getByRole("combobox", { name: "settings.mcpServerTransport" }));
        await user.click(screen.getByRole("option", { name: "settings.mcpServerTransportStdio" }));
        expect((screen.getByLabelText("settings.mcpServerCommand") as HTMLInputElement).value).toBe(
            "node",
        );
        expect((screen.getByLabelText("settings.mcpServerEnv") as HTMLTextAreaElement).value).toBe(
            "TOKEN=secret=with=equals\nEMPTY=",
        );
        await waitFor(() => expect(saveButton().hasAttribute("disabled")).toBe(false));
    });
    it("cleared optional fields are omitted from the wire payload", async () => {
        const onSave = mount();
        for (const label of ["Args", "Env", "Cwd", "Timeout", "AlwaysLoaded"]) {
            fireEvent.change(screen.getByLabelText(`settings.mcpServer${label}`), {
                target: { value: "" },
            });
        }
        await waitFor(() => expect(saveButton().hasAttribute("disabled")).toBe(false));
        await userEvent.click(saveButton());
        await waitFor(() => expect(onSave).toHaveBeenCalled());
        expect(JSON.parse(JSON.stringify(onSave.mock.calls[0]?.[0]))).toEqual({
            id: existing.id,
            transport: "stdio",
            command: "node",
        });
    });
    it("blocks duplicate ids, invalid endpoints and non-positive timeouts", async () => {
        const user = userEvent.setup({ delay: null });
        const onSave = vi.fn();
        render(<McpServerForm existingIds={["taken"]} onSave={onSave} onCancel={vi.fn()} />);
        fireEvent.change(screen.getByLabelText("settings.mcpServerId"), {
            target: { value: "taken" },
        });
        fireEvent.change(screen.getByLabelText("settings.mcpServerCommand"), {
            target: { value: "node" },
        });
        await screen.findByText("settings.mcpServerIdClash");
        expect(saveButton().hasAttribute("disabled")).toBe(true);
        fireEvent.change(screen.getByLabelText("settings.mcpServerId"), {
            target: { value: "new-server" },
        });
        await waitFor(() => expect(saveButton().hasAttribute("disabled")).toBe(false));
        fireEvent.change(screen.getByLabelText("settings.mcpServerTimeout"), {
            target: { value: "0" },
        });
        await waitFor(() => expect(saveButton().hasAttribute("disabled")).toBe(true));
        fireEvent.change(screen.getByLabelText("settings.mcpServerTimeout"), {
            target: { value: "" },
        });
        await user.click(screen.getByRole("combobox", { name: "settings.mcpServerTransport" }));
        await user.click(screen.getByRole("option", { name: "settings.mcpServerTransportHttp" }));
        fireEvent.change(screen.getByLabelText("settings.mcpServerUrl"), {
            target: { value: "file:///local" },
        });
        await screen.findByText("settings.mcpServerUrlInvalid");
        expect(saveButton().hasAttribute("disabled")).toBe(true);
        expect(onSave).not.toHaveBeenCalled();
    });

    it("restores invalid URL feedback when returning from a failed stdio save", async () => {
        const user = userEvent.setup({ delay: null });
        mount(existing, vi.fn().mockRejectedValue(new Error("failed")));
        const transport = () =>
            screen.getByRole("combobox", { name: "settings.mcpServerTransport" });
        await user.click(transport());
        await user.click(screen.getByRole("option", { name: "settings.mcpServerTransportHttp" }));
        fireEvent.change(screen.getByLabelText("settings.mcpServerUrl"), {
            target: { value: "file:///local" },
        });
        await screen.findByText("settings.mcpServerUrlInvalid");
        await user.click(transport());
        await user.click(screen.getByRole("option", { name: "settings.mcpServerTransportStdio" }));
        await waitFor(() => expect(saveButton().hasAttribute("disabled")).toBe(false));
        await user.click(saveButton());
        await waitFor(() => expect(saveButton().hasAttribute("disabled")).toBe(false));
        await user.click(transport());
        await user.click(screen.getByRole("option", { name: "settings.mcpServerTransportHttp" }));
        await screen.findByText("settings.mcpServerUrlInvalid");
    });

    it("submits only once for clicks in the same event batch", async () => {
        let finish = () => {};
        const pending = new Promise<void>((resolve) => {
            finish = resolve;
        });
        const onSave = vi.fn(() => pending);
        mount(existing, onSave);
        await waitFor(() => expect(saveButton().hasAttribute("disabled")).toBe(false));
        const button = saveButton();
        await act(async () => {
            fireEvent.click(button);
            fireEvent.click(button);
        });
        const callCount = onSave.mock.calls.length;
        await act(async () => finish());
        expect(callCount).toBe(1);
    });

    it("keeps draft values and allows retry after a rejected save", async () => {
        const onSave = vi
            .fn()
            .mockRejectedValueOnce(new Error("save failed"))
            .mockResolvedValue(undefined);
        mount(existing, onSave);
        await waitFor(() => expect(saveButton().hasAttribute("disabled")).toBe(false));
        await userEvent.click(saveButton());
        await waitFor(() => expect(saveButton().hasAttribute("disabled")).toBe(false));
        expect(
            (screen.getByLabelText("settings.mcpServerEnv") as HTMLTextAreaElement).value,
        ).toContain("secret=with=equals");
        await userEvent.click(saveButton());
        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    });

    it("holds submission until the async save settles without relying on external saving", async () => {
        let finish = () => {};
        const pending = new Promise<void>((resolve) => {
            finish = resolve;
        });
        const onSave = vi.fn(() => pending);
        mount(existing, onSave);
        await waitFor(() => expect(saveButton().hasAttribute("disabled")).toBe(false));
        await userEvent.click(saveButton());
        await waitFor(() =>
            expect(
                screen
                    .getByRole("button", { name: "settings.mcpServerSaving" })
                    .hasAttribute("disabled"),
            ).toBe(true),
        );
        expect(
            screen
                .getByRole("button", { name: "settings.mcpServerCancel" })
                .hasAttribute("disabled"),
        ).toBe(true);
        expect(onSave).toHaveBeenCalledTimes(1);
        finish();
        await waitFor(() => expect(saveButton().hasAttribute("disabled")).toBe(false));
    });
});
