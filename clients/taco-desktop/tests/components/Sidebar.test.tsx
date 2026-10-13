import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Sidebar } from "../../src/views/Sidebar";
import * as useI18n from "../../src/i18n/useI18n";
import "../../src/styles.css";

vi.spyOn(useI18n, "useT").mockReturnValue({
    t: (key: string) => key,
} as unknown as ReturnType<typeof useI18n.useT>);
vi.spyOn(useI18n, "useUiLanguage").mockReturnValue("en");

afterEach(cleanup);

describe("Sidebar session actions", () => {
    it("keeps rename and delete actions keyboard reachable when idle", async () => {
        render(
            <Sidebar
                ws={{
                    sessions: [{ id: "session-1", name: "Session", createdAt: 0 }],
                    activeSession: null,
                    pendingBySessionId: {},
                } as never}
                onAttach={() => {}}
                onDelete={() => {}}
                onRename={() => {}}
            />,
        );

        const rename = screen.getByRole("button", { name: "session.rename" });
        const remove = screen.getByRole("button", { name: "session.deleteSession" });

        const user = userEvent.setup();
        await user.tab();
        expect(document.activeElement).toBe(rename);
        await user.tab();
        expect(document.activeElement).toBe(remove);

        // The actions must remain in the sequential focus order while idle.
        // CSS hides them visually with opacity, not display:none, so Tab can
        // focus the first action and :focus-within can reveal the row.
        const css = readFileSync("src/styles/sidebar.css", "utf8");
        const actionRule = (css.match(/\.session-action\s*\{([\s\S]*?)\}/)?.[1] ?? "")
            .replace(/\/\*[\s\S]*?\*\//g, "");
        expect(actionRule).toContain("opacity: 0");
        expect(actionRule).not.toContain("display: none");
        expect(rename.getAttribute("tabindex")).toBeNull();
        expect(remove.getAttribute("tabindex")).toBeNull();
    });
});
