import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, it, vi } from "vitest";
import { WorkspaceModeTabs } from "../../src/components/WorkspaceModeTabs.tsx";

vi.mock("../../src/i18n/useI18n", () => ({
    useT: () => ({ t: (key: string) => key }),
}));

describe("WorkspaceModeTabs", () => {
    afterEach(cleanup);

    it("notifies when the selected tab is clicked so a pending switch can be cancelled", async () => {
        const onModeChange = vi.fn();
        const user = userEvent.setup({ delay: null });
        render(<WorkspaceModeTabs mode="workspace" onModeChange={onModeChange} />);

        await user.click(screen.getByRole("radio", { name: "workspaceMode.workspace" }));

        assert.deepEqual(onModeChange.mock.calls, [["workspace"]]);
    });

    it("puts a colour dot in front of the label of the selected segment", () => {
        const { rerender } = render(<WorkspaceModeTabs mode="workspace" onModeChange={() => {}} />);

        const workspaceTab = screen.getByRole("radio", { name: "workspaceMode.workspace" });
        const imTab = screen.getByRole("radio", { name: "workspaceMode.im" });
        // Both segments carry the dot slot, so the two keep the same width
        // and the control does not resize when the selection moves.
        const workspaceDot = workspaceTab.querySelector(".workspace-mode-tab__dot");
        const imDot = imTab.querySelector(".workspace-mode-tab__dot");
        assert.ok(workspaceDot, "the workspace segment has a dot slot");
        assert.ok(imDot, "the channel segment has a dot slot");
        assert.equal(workspaceDot?.getAttribute("aria-hidden"), "true");
        assert.ok(workspaceTab.className.includes("workspace-mode-tab--workspace"));

        rerender(<WorkspaceModeTabs mode="im" onModeChange={() => {}} />);

        const imTabSelected = screen.getByRole("radio", { name: "workspaceMode.im" });
        assert.ok(imTabSelected.className.includes("workspace-mode-tab--im"));
    });

    it("rounds the segments into a pill with half-circle ends", () => {
        const css = readFileSync(
            resolve(dirname(fileURLToPath(import.meta.url)), "../../src/styles/layout.css"),
            "utf8",
        );
        const at = css.indexOf(".workspace-mode-tab {");
        const open = css.indexOf("{", at);
        const rule = css.slice(open + 1, css.indexOf("}", open));
        // A pill radius on a 24px-tall segment resolves to half the height, so
        // the left and right ends are half-circles.
        assert.match(rule, /border-radius:\s*var\(--radius-pill\)/);
    });

    it("draws the selected segment's edge darker than its surface in the dark theme", () => {
        const css = readFileSync(
            resolve(dirname(fileURLToPath(import.meta.url)), "../../src/styles/theme.css"),
            "utf8",
        );
        const dark = css.slice(0, css.indexOf(':root[data-theme="light"]'));
        const token = (name: string): string =>
            dark.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1]?.trim() ?? "";
        // The active surface points one level up the scale — follow the chain.
        const surface = token("segment-active-bg").replace(
            /var\(--([a-z0-9-]+)\)/,
            (_match, referenced: string) => token(referenced),
        );
        const edge = token("segment-active-border");
        const luminance = (hex: string): number => {
            const value = hex.replace("#", "");
            const channels = [0, 2, 4].map((offset) => {
                const channel = Number.parseInt(value.slice(offset, offset + 2), 16) / 255;
                return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
            });
            return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
        };
        // A lighter edge would outline the pill; the dark theme wants the line
        // one shade below the surface it sits on.
        assert.ok(luminance(edge) < luminance(surface), `${edge} should be darker than ${surface}`);
    });

    it("gives the workspace dot the brand orange and the channel dot the accent blue", () => {
        const css = readFileSync(
            resolve(dirname(fileURLToPath(import.meta.url)), "../../src/styles/layout.css"),
            "utf8",
        );
        // Index-based lookup: a regex that never matches would backtrack over
        // the whole stylesheet and stall the worker.
        const ruleBody = (selector: string): string => {
            const at = css.indexOf(selector);
            if (at < 0) return "";
            const open = css.indexOf("{", at);
            return css.slice(open + 1, css.indexOf("}", open));
        };

        assert.match(
            ruleBody(".workspace-mode-tab--workspace .workspace-mode-tab__dot"),
            /var\(--brand-orange\)/,
        );
        assert.match(
            ruleBody(".workspace-mode-tab--im .workspace-mode-tab__dot"),
            /var\(--accent\)/,
        );
    });
});
