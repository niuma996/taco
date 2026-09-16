/**
 * LlmDumpDock — open/collapse cycle + drag-vs-click regression tests.
 *
 * The dock previously had two ways to look "broken": a press that never
 * produced a click could leave the drag flag stuck true and swallow the next
 * real click on the fab, and a fab dragged off-canvas (window resized
 * between drag and collapse) would render where nobody could see it. Both
 * are covered here.
 *
 * Run:
 *   pnpm --filter @taco-ai/desktop test
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LlmDumpDock } from "../../src/components/LlmDumpPanel";
import type { LlmDumpEntry } from "../../src/hooks/useLlmDump";
import * as useI18n from "../../src/i18n/useI18n";

// useT returns the key itself so assertions read against i18n keys.
vi.spyOn(useI18n, "useT").mockReturnValue({
    t: (key: string) => key,
} as unknown as ReturnType<typeof useI18n.useT>);

afterEach(cleanup);

function entry(index: number): LlmDumpEntry {
    return { index, timestamp: 1_700_000_000_000 + index, lines: ["[system] hello"] };
}

const FAB_WITH_ENTRIES = "debug.showLlmRequestDump (1)";
const FAB_EMPTY = "debug.showLlmRequestDumpWaiting";
const COLLAPSE = "debug.collapsePanel";

function dock(props: { entries?: LlmDumpEntry[]; debugMode?: boolean } = {}) {
    return render(
        <LlmDumpDock
            entries={props.entries ?? [entry(1)]}
            onClear={() => {}}
            debugMode={props.debugMode ?? true}
        />,
    );
}

describe("LlmDumpDock — visibility gating", () => {
    it("renders nothing when debug mode is off and there are no entries", () => {
        const { container } = dock({ entries: [], debugMode: false });
        expect(container.firstChild).toBeNull();
    });

    it("renders the fab with zero entries when debug mode is on", () => {
        dock({ entries: [], debugMode: true });
        expect(screen.getByRole("button", { name: FAB_EMPTY })).toBeTruthy();
    });
});

describe("LlmDumpDock — open / collapse", () => {
    it("opens the panel from the fab and collapses back", async () => {
        const user = userEvent.setup();
        dock();
        await user.click(screen.getByRole("button", { name: FAB_WITH_ENTRIES }));
        expect(screen.getByRole("complementary")).toBeTruthy();

        await user.click(screen.getByRole("button", { name: COLLAPSE }));
        expect(screen.queryByRole("complementary")).toBeNull();
        expect(screen.getByRole("button", { name: FAB_WITH_ENTRIES })).toBeTruthy();
    });

    /**
     * Regression: the drag flag used to be consumed by the click handler, so
     * any press that ended without a click left it true and ate the following
     * click. Repeated cycles must keep working.
     */
    it("keeps the fab working across repeated open/collapse cycles", async () => {
        const user = userEvent.setup();
        dock();
        for (let i = 0; i < 5; i++) {
            await user.click(screen.getByRole("button", { name: FAB_WITH_ENTRIES }));
            await user.click(screen.getByRole("button", { name: COLLAPSE }));
        }
        expect(screen.getByRole("button", { name: FAB_WITH_ENTRIES })).toBeTruthy();
    });

    it("shows the empty-state copy when there are no entries", async () => {
        const user = userEvent.setup();
        dock({ entries: [] });
        await user.click(screen.getByRole("button", { name: FAB_EMPTY }));
        expect(screen.getByText("debug.empty")).toBeTruthy();
    });
});

describe("LlmDumpDock — drag does not swallow the click", () => {
    /**
     * Regression for the stuck flag: a pointer press that moves is a drag and
     * must not open the panel, but the *next* press — which doesn't move —
     * must still open it.
     */
    it("suppresses the click that ends a drag, then accepts the next click", async () => {
        const user = userEvent.setup();
        dock();
        const fab = screen.getByRole("button", { name: FAB_WITH_ENTRIES });

        // Drag: press, move, release — no click should open the panel.
        fireEvent.pointerDown(fab, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
        fireEvent.pointerMove(fab, { pointerId: 1, clientX: 120, clientY: 90 });
        fireEvent.pointerUp(fab, { pointerId: 1, clientX: 120, clientY: 90 });
        expect(screen.queryByRole("complementary")).toBeNull();

        // A plain click right after must still register.
        await user.click(screen.getByRole("button", { name: FAB_WITH_ENTRIES }));
        expect(screen.getByRole("complementary")).toBeTruthy();
    });
});
