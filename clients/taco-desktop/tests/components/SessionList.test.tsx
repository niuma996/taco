import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionList, type SessionListItem } from "../../src/components/SessionList";
import * as useI18n from "../../src/i18n/useI18n";
import "../../src/styles.css";

vi.spyOn(useI18n, "useT").mockReturnValue({
    t: (key: string) => key,
} as unknown as ReturnType<typeof useI18n.useT>);
vi.spyOn(useI18n, "useUiLanguage").mockReturnValue("en");

afterEach(cleanup);

function item(overrides: Partial<SessionListItem> = {}): SessionListItem {
    return {
        key: "session-1",
        id: "session-1",
        label: "Session",
        updatedAt: "1970-01-01T00:00:00Z",
        running: false,
        active: false,
        ...overrides,
    };
}

function renderList(row: SessionListItem) {
    const onDelete = vi.fn();
    render(
        <SessionList
            className="sidebar-list"
            items={[row]}
            onOpen={() => {}}
            onRename={() => {}}
            onDelete={onDelete}
        />,
    );
    return onDelete;
}

describe("SessionList delete action", () => {
    it("deletes an idle session", async () => {
        const onDelete = renderList(item());
        const user = userEvent.setup({ delay: null });

        await user.click(screen.getByRole("button", { name: "session.moreActions" }));
        await user.click(screen.getByRole("menuitem", { name: /session.deleteSession/ }));

        expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: "session-1" }));
    });

    it("grays out the delete action of a running session and says why", async () => {
        const onDelete = renderList(item({ running: true }));
        const user = userEvent.setup({ delay: null });

        await user.click(screen.getByRole("button", { name: "session.moreActions" }));
        const deleteItem = screen.getByRole("menuitem", { name: /session.deleteSession/ });
        expect(deleteItem.getAttribute("aria-disabled")).toBe("true");

        await user.click(deleteItem);
        expect(onDelete).not.toHaveBeenCalled();

        await user.hover(deleteItem);
        await waitFor(() => expect(screen.getByText("session.deleteWhileRunning")).toBeTruthy());
    });

    it("puts the tooltip above the menu it explains", () => {
        const css = readFileSync(
            resolve(dirname(fileURLToPath(import.meta.url)), "../../src/styles/ui.css"),
            "utf8",
        );
        const zIndexOf = (selector: string): number => {
            const rule =
                css.match(
                    new RegExp(`${selector.replace(/\./g, "\\.")}\\s*\\{([\\s\\S]*?)\\}`),
                )?.[1] ?? "";
            return Number(rule.match(/z-index:\s*(\d+)/)?.[1] ?? "0");
        };
        // The bubble is portaled to the body, so it needs its own layer above
        // the menu it belongs to — otherwise it is painted underneath it.
        expect(zIndexOf(".ui-tooltip-above-menu")).toBeGreaterThan(zIndexOf(".ui-menu"));
    });
});
