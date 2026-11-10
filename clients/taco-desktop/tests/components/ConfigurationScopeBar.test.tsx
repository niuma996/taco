import { strict as assert } from "node:assert";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, it, vi } from "vitest";
import { ConfigurationScopeBar } from "../../src/components/ConfigurationScopeBar";

vi.mock("react-i18next", () => ({
    useTranslation: vi.fn(() => ({ t: (key: string) => key, i18n: { language: "en" } })),
}));
afterEach(cleanup);
const targets = [{ value: "/repo", label: "repo", detail: "/repo", kind: "workspace" as const }];

describe("ConfigurationScopeBar", () => {
    it("keeps the target picker above source tabs, including when viewing global definitions", () => {
        const onScopeChange = vi.fn();
        const view = render(
            <ConfigurationScopeBar
                variant="catalog"
                scope="effective"
                onScopeChange={onScopeChange}
                targetCwd="/repo"
                targetOptions={targets}
                onTargetChange={() => {}}
            />,
        );
        assert.equal(screen.getAllByRole("tab").length, 4);
        assert.equal(
            screen
                .getByRole("tab", { name: /configScope.effective/ })
                .getAttribute("aria-selected"),
            "true",
        );
        assert.ok(screen.getByRole("tab", { name: /configScope.builtin/ }));
        assert.equal(screen.queryByRole("tab", { name: /configScope.channel/ }), null);
        const picker = screen.getByRole("combobox", { name: "configScope.targetLabel" });
        assert.ok(
            picker.compareDocumentPosition(screen.getByRole("tablist")) &
                Node.DOCUMENT_POSITION_FOLLOWING,
        );
        fireEvent.keyDown(screen.getByRole("tablist"), { key: "ArrowRight" });
        assert.deepEqual(onScopeChange.mock.calls.at(-1), ["global"]);
        view.rerender(
            <ConfigurationScopeBar
                variant="catalog"
                scope="global"
                onScopeChange={onScopeChange}
                targetCwd="/repo"
                targetOptions={targets}
                onTargetChange={() => {}}
            />,
        );
        assert.ok(screen.getByRole("combobox", { name: "configScope.targetLabel" }));
        assert.ok(screen.getByText("~/.taco"));
    });

    it("shows only the effective source for runtime tools and handles an absent target", () => {
        const view = render(
            <ConfigurationScopeBar
                variant="runtime"
                scope="effective"
                onScopeChange={() => {}}
                targetCwd="/repo"
                targetOptions={targets}
                onTargetChange={() => {}}
            />,
        );
        assert.equal(screen.getAllByRole("tab").length, 1);
        assert.ok(screen.getByRole("combobox"));
        view.rerender(
            <ConfigurationScopeBar
                variant="catalog"
                scope="effective"
                onScopeChange={() => {}}
                targetCwd={undefined}
                targetOptions={[]}
                onTargetChange={() => {}}
            />,
        );
        assert.ok(screen.getByText("configScope.noTarget"));
        assert.equal(screen.queryByRole("combobox"), null);
    });

    it("can render only the shared target picker for memory layers", () => {
        render(
            <ConfigurationScopeBar
                variant="target"
                mode="im"
                scope="effective"
                onScopeChange={() => {}}
                targetCwd="im://wechat/peer/chat"
                targetOptions={[
                    {
                        value: "im://wechat/peer/chat",
                        label: "Project chat",
                        detail: "im://wechat/peer/chat",
                        kind: "channel",
                        channelId: "wechat",
                    },
                ]}
                onTargetChange={() => {}}
            />,
        );
        assert.ok(screen.getByRole("combobox", { name: "configScope.targetLabel" }));
        assert.equal(screen.queryByRole("tablist"), null);
    });

    it("distinguishes a loading IM list, a failed load and an empty result", () => {
        const retry = vi.fn();
        const input = {
            variant: "catalog" as const,
            scope: "effective" as const,
            mode: "im" as const,
            onScopeChange: () => {},
            targetCwd: undefined,
            targetOptions: [],
            onTargetChange: () => {},
            onRetryTargets: retry,
        };
        const view = render(<ConfigurationScopeBar {...input} targetsLoading />);
        assert.ok(screen.getByText("conversationNav.loading"));
        view.rerender(<ConfigurationScopeBar {...input} targetsError="offline" />);
        fireEvent.click(screen.getByRole("button", { name: "conversationNav.retry" }));
        assert.equal(retry.mock.calls.length, 1);
        view.rerender(<ConfigurationScopeBar {...input} />);
        assert.ok(screen.getByText("configScope.noChannel"));
    });
});
