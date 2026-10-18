/**
 * TopbarQuickActions — notification bell + language / theme shortcut menus.
 *
 * Locks the write path: picking a language or theme calls writeClientSettings
 * with the matching client-settings patch, and the current value is marked
 * with a check in the open menu. Plus the bell's contract with App: a
 * notification that lands while the bell is closed is forwarded to
 * `onNewNotification`, which is the only reason a failure stays visible now
 * that the banner is gone.
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TopbarQuickActions } from "../../src/components/TopbarQuickActions";
import * as useGlobalConfig from "../../src/hooks/primitives/useGlobalConfig";
import * as useI18n from "../../src/i18n/useI18n";
import * as globalConfig from "../../src/lib/globalConfig";
import type { AppNotification } from "../../src/lib/notifications";

vi.spyOn(useI18n, "useT").mockReturnValue({
    t: (key: string) => key,
} as unknown as ReturnType<typeof useI18n.useT>);

vi.spyOn(useI18n, "useUiLanguage").mockReturnValue("en");

vi.spyOn(useGlobalConfig, "useGlobalConfig").mockReturnValue({
    global: {},
    client: { theme: "system", uiLanguage: "en" },
    loaded: true,
});

const writeClientSettings = vi
    .spyOn(globalConfig, "writeClientSettings")
    .mockResolvedValue(undefined);

afterEach(cleanup);

beforeEach(() => {
    writeClientSettings.mockClear();
});

// Most of these tests only cover the two menus, so the bell renders empty.
const noNotifications = {
    notifications: [],
    onDismissNotification: () => {},
    onClearNotifications: () => {},
};

describe("TopbarQuickActions", () => {
    it("writes uiLanguage when a language option is picked", async () => {
        const user = userEvent.setup();
        render(<TopbarQuickActions {...noNotifications} />);

        await user.click(screen.getByRole("button", { name: "app.language" }));
        await user.click(
            await screen.findByRole("menuitem", { name: /settings.languageOptionZh/ }),
        );

        expect(writeClientSettings).toHaveBeenCalledWith({ uiLanguage: "zh" });
    });

    it("writes theme when a theme option is picked", async () => {
        const user = userEvent.setup();
        render(<TopbarQuickActions {...noNotifications} />);

        await user.click(screen.getByRole("button", { name: "app.theme" }));
        await user.click(await screen.findByRole("menuitem", { name: /settings.themeOptionDark/ }));

        expect(writeClientSettings).toHaveBeenCalledWith({ theme: "dark" });
    });

    it("marks the current language and theme in their menus", async () => {
        const user = userEvent.setup();
        render(<TopbarQuickActions {...noNotifications} />);

        await user.click(screen.getByRole("button", { name: "app.language" }));
        const enItem = await screen.findByRole("menuitem", {
            name: /settings.languageOptionEn/,
        });
        expect(enItem.querySelector("svg")).not.toBeNull();

        await user.keyboard("{Escape}");
        await user.click(screen.getByRole("button", { name: "app.theme" }));
        const systemItem = await screen.findByRole("menuitem", {
            name: /settings.themeOptionSystem/,
        });
        expect(systemItem.querySelector("svg")).not.toBeNull();
        const darkItem = screen.getByRole("menuitem", {
            name: /settings.themeOptionDark/,
        });
        expect(darkItem.querySelector("svg")).toBeNull();
    });
    it("badges a pending notification and forwards it while the bell is closed", async () => {
        const user = userEvent.setup();
        const onNewNotification = vi.fn();
        function Harness() {
            const [rows, setRows] = useState<AppNotification[]>([]);
            return (
                <>
                    <button
                        type="button"
                        onClick={() =>
                            setRows((p) => [
                                {
                                    id: 1,
                                    text: "Prompt failed: boom",
                                    at: Date.now(),
                                    count: 1,
                                    kind: "generic",
                                    source: "client",
                                    level: "error",
                                },
                                ...p,
                            ])
                        }
                    >
                        fail
                    </button>
                    <TopbarQuickActions
                        notifications={rows}
                        onDismissNotification={() => {}}
                        onClearNotifications={() => {}}
                        onNewNotification={onNewNotification}
                    />
                </>
            );
        }
        render(<Harness />);

        await user.click(screen.getByRole("button", { name: "fail" }));

        expect(document.querySelector(".notification-bell__badge")?.textContent).toBe("1");
        expect(onNewNotification).toHaveBeenCalledWith(
            expect.objectContaining({ id: 1, text: "Prompt failed: boom" }),
        );
    });

    it("opens workspace approvals from a button left of notifications", async () => {
        const user = userEvent.setup();
        const onOpenPendingApprovals = vi.fn();
        render(
            <TopbarQuickActions
                {...noNotifications}
                pendingApprovalCount={2}
                onOpenPendingApprovals={onOpenPendingApprovals}
            />,
        );

        const approvals = screen.getByRole("button", {
            name: /session\.pendingPermissions/,
        });
        const bell = screen.getByRole("button", { name: "app.notifications" });
        expect(approvals.compareDocumentPosition(bell) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(
            0,
        );
        expect(document.querySelector(".workspace-approval-button__count")?.textContent).toBe("2");

        await user.click(approvals);
        expect(onOpenPendingApprovals).toHaveBeenCalledOnce();
    });
});

describe("TopbarQuickActions approvals button", () => {
    it("stays visible with no pending approvals and hides only the count", async () => {
        const user = userEvent.setup();
        const onOpenPendingApprovals = vi.fn();
        render(
            <TopbarQuickActions
                {...noNotifications}
                pendingApprovalCount={0}
                onOpenPendingApprovals={onOpenPendingApprovals}
            />,
        );

        const approvals = screen.getByRole("button", { name: /session\.pendingPermissions/ });
        expect(document.querySelector(".workspace-approval-button__count")).toBeNull();
        expect(approvals.className).not.toContain("workspace-approval-button--pending");

        await user.click(approvals);
        expect(onOpenPendingApprovals).toHaveBeenCalledOnce();
    });
});
