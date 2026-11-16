import type { ExtensionsStatusResult } from "@taco-ai/protocol";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginsPane } from "../../src/views/PluginsPane";

vi.mock("react-i18next", () => ({
    useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

describe("PluginsPane", () => {
    afterEach(cleanup);

    it("renders responses from a sidecar without lifecycle diagnostics", () => {
        const legacy = {
            loaded: [{ name: "legacy", version: "1.0.0", source: "external", permissions: [] }],
            disabled: ["disabled"],
            failed: [{ name: "broken", reason: "import failed" }],
            unauthorized: [],
        } as unknown as ExtensionsStatusResult;
        render(
            <PluginsPane
                status={legacy}
                loading={false}
                error={null}
                savingName={null}
                onToggle={() => {}}
                pendingRestart={false}
                restarting={false}
                onRestart={() => {}}
            />,
        );
        expect(screen.getByText("legacy")).toBeTruthy();
        expect(screen.getByText("disabled")).toBeTruthy();
        expect(screen.getByText("broken")).toBeTruthy();
    });
    it("shows only registered capabilities and reveals counts on demand", () => {
        const status: ExtensionsStatusResult = {
            loaded: [
                {
                    name: "workspace-plugin",
                    version: "1",
                    source: "builtin",
                    permissions: [],
                    contributions: {
                        tools: ["convertDocument"],
                        deferredTools: [],
                        tags: [],
                        contextHooks: 0,
                        toolCallHooks: 0,
                        toolResultHooks: 1,
                        systemPrompts: 0,
                        workspaceActivators: 1,
                        sessionActivators: 0,
                    },
                },
            ],
            disabled: [],
            disabledEntries: [],
            failed: [],
            unauthorized: [],
            pendingRestart: {
                loadedButDisabled: [],
                disabledButEnabled: [],
                failed: [],
                configuration: [],
            },
        };
        render(
            <PluginsPane
                status={status}
                loading={false}
                error={null}
                savingName={null}
                onToggle={() => {}}
                pendingRestart={false}
                restarting={false}
                onRestart={() => {}}
            />,
        );
        expect(screen.getByText("plugins.capabilityToolResult")).toBeTruthy();
        expect(screen.queryByText("plugins.capabilityContext")).toBeNull();
        expect(screen.queryByText("convertDocument")).toBeNull();
        const toggle = screen.getByRole("button", { name: "plugins.showRegistrations" });
        expect(toggle.getAttribute("aria-expanded")).toBe("false");
        fireEvent.click(toggle);
        expect(toggle.getAttribute("aria-expanded")).toBe("true");
        expect(screen.getByText("convertDocument")).toBeTruthy();
        expect(screen.getByText("plugins.registrationScopeHint")).toBeTruthy();
        fireEvent.click(toggle);
        expect(screen.queryByText("convertDocument")).toBeNull();
    });
});
