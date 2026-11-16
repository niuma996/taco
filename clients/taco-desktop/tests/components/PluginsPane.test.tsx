import type { ExtensionsStatusResult } from "@taco-ai/protocol";
import { cleanup, render, screen } from "@testing-library/react";
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
});
