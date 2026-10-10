/**
 * NotificationBell — the list that replaced the full-width error banner.
 *
 * Locks the behaviors the topbar depends on: unread badge until the popover is
 * opened, per-row dismissal, clear-all — and the two that only exist because
 * the banner went away: a row arriving at a *closed* bell still reaches the
 * user (toast + live region), and a row arriving at an *open* one does not
 * re-badge what is already on screen.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { formatNotificationStamp, NotificationBell } from "../../src/components/NotificationBell";
import * as useI18n from "../../src/i18n/useI18n";
import type { AppNotification } from "../../src/lib/notifications";

vi.spyOn(useI18n, "useT").mockReturnValue({
    // Keys pass through; `count` is interpolated so the unread label still
    // carries a number the assertion can look for.
    t: (key: string, opts?: { count?: number }) => (opts?.count ? `${key}:${opts.count}` : key),
} as unknown as ReturnType<typeof useI18n.useT>);

afterEach(cleanup);

const entry = (
    id: number,
    text: string,
    at: number,
    count = 1,
    source: AppNotification["source"] = "client",
): AppNotification => ({
    id,
    text,
    at,
    count,
    kind: "generic",
    source,
    level: "error",
});

const badge = () => document.querySelector(".notification-bell__badge")?.textContent ?? null;
const trigger = () => screen.getByRole("button", { name: /app\.notifications/ });

describe("NotificationBell", () => {
    it("shows the unread count and clears it once the list is opened", async () => {
        const user = userEvent.setup();
        render(
            <NotificationBell
                notifications={[
                    entry(2, "second", Date.now()),
                    entry(1, "first", Date.now() - 60_000),
                ]}
                onDismiss={() => {}}
                onClearAll={() => {}}
            />,
        );

        // Newest first — the badge counts both until the list is opened.
        expect(badge()).toBe("2");
        await user.click(trigger());
        expect(screen.getByText("second")).not.toBeNull();
        expect(screen.getByText("first")).not.toBeNull();
        expect(badge()).toBeNull();
    });

    it("shows the empty state when nothing has been pushed", async () => {
        const user = userEvent.setup();
        render(<NotificationBell notifications={[]} onDismiss={() => {}} onClearAll={() => {}} />);

        await user.click(trigger());
        expect(screen.getByText("app.notificationsEmpty")).not.toBeNull();
        expect(screen.queryByRole("button", { name: "app.notificationsClearAll" })).toBeNull();
    });

    it("dismisses one row and clears the rest", async () => {
        const user = userEvent.setup();
        const onDismiss = vi.fn();
        const onClearAll = vi.fn();
        render(
            <NotificationBell
                notifications={[entry(1, "first", Date.now())]}
                onDismiss={onDismiss}
                onClearAll={onClearAll}
            />,
        );

        await user.click(trigger());
        await user.click(screen.getByRole("button", { name: "app.dismiss" }));
        expect(onDismiss).toHaveBeenCalledWith(1);

        await user.click(screen.getByRole("button", { name: "app.notificationsClearAll" }));
        expect(onClearAll).toHaveBeenCalled();
    });

    it("renders the repeat count on a coalesced row", async () => {
        const user = userEvent.setup();
        render(
            <NotificationBell
                notifications={[entry(1, "disk is full", Date.now(), 7)]}
                onDismiss={() => {}}
                onClearAll={() => {}}
            />,
        );

        await user.click(trigger());
        expect(screen.getByText("×7")).not.toBeNull();
        // A single occurrence has no counter to show.
        expect(screen.queryByText("×1")).toBeNull();
    });

    it("does not badge rows that arrive while the list is already open", async () => {
        const user = userEvent.setup();
        const onNewArrival = vi.fn();
        // Pushed through state, not a click: clicking anywhere outside the
        // popover would close it, which is the *other* test's scenario.
        let push = () => {};
        function Harness() {
            const [rows, setRows] = useState([entry(1, "first", Date.now())]);
            push = () => setRows((p) => [entry(2, "second", Date.now()), ...p]);
            return (
                <NotificationBell
                    notifications={rows}
                    onDismiss={() => {}}
                    onClearAll={() => {}}
                    onNewArrival={onNewArrival}
                />
            );
        }
        render(<Harness />);

        await user.click(trigger());
        expect(badge()).toBeNull();
        await act(async () => {
            push();
        });

        // Already on screen — re-badging or re-toasting would be noise.
        expect(badge()).toBeNull();
        expect(onNewArrival).not.toHaveBeenCalled();
        expect(screen.getByText("second")).not.toBeNull();
    });

    it("reports rows that arrive while the bell is closed", async () => {
        const user = userEvent.setup();
        const onNewArrival = vi.fn();
        function Harness() {
            const [rows, setRows] = useState<AppNotification[]>([]);
            return (
                <>
                    <button
                        type="button"
                        onClick={() => setRows((p) => [entry(1, "boom", Date.now()), ...p])}
                    >
                        push
                    </button>
                    <NotificationBell
                        notifications={rows}
                        onDismiss={() => {}}
                        onClearAll={() => {}}
                        onNewArrival={onNewArrival}
                    />
                </>
            );
        }
        render(<Harness />);

        await user.click(screen.getByRole("button", { name: "push" }));

        expect(onNewArrival).toHaveBeenCalledWith(expect.objectContaining({ text: "boom" }));
        expect(badge()).toBe("1");
    });

    it("keeps a row read after the popover closes again", async () => {
        const user = userEvent.setup();
        function Harness() {
            const [rows, setRows] = useState<AppNotification[]>([]);
            return (
                <>
                    <button
                        type="button"
                        // Fresh id per push, as the store allocates them.
                        onClick={() =>
                            setRows((p) => [entry(p.length + 1, "boom", Date.now()), ...p])
                        }
                    >
                        push
                    </button>
                    <NotificationBell
                        notifications={rows}
                        onDismiss={() => {}}
                        onClearAll={() => {}}
                        onNewArrival={vi.fn()}
                    />
                </>
            );
        }
        render(<Harness />);

        await user.click(screen.getByRole("button", { name: "push" }));
        expect(badge()).toBe("1");
        await user.click(trigger());
        expect(badge()).toBeNull();
        await user.keyboard("{Escape}");
        // "Unread" means unread: what the user just looked at stays read, and
        // the trigger stops announcing it.
        expect(badge()).toBeNull();
        expect(trigger().getAttribute("aria-label")).toBe("app.notifications");

        // A genuinely new row badges again — just that one.
        await user.click(screen.getByRole("button", { name: "push" }));
        expect(badge()).toBe("1");
    });

    it("does not re-report an older row when the newest is dismissed while closed", async () => {
        // Regression: arrival detection compared the head id for inequality, so
        // removing the head (onboarding dismisses its own workspace-open row
        // before a retry) made the next-older row look new and toasted it again.
        const onNewArrival = vi.fn();
        let setRows: (f: (p: AppNotification[]) => AppNotification[]) => void = () => {};
        function Harness() {
            const [rows, s] = useState<AppNotification[]>([]);
            setRows = s;
            return (
                <NotificationBell
                    notifications={rows}
                    onDismiss={() => {}}
                    onClearAll={() => {}}
                    onNewArrival={onNewArrival}
                />
            );
        }
        render(<Harness />);
        await act(async () => setRows((p) => [entry(1, "older", Date.now()), ...p]));
        await act(async () => setRows((p) => [entry(2, "newest", Date.now()), ...p]));
        expect(onNewArrival).toHaveBeenCalledTimes(2);

        await act(async () => setRows((p) => p.filter((n) => n.id !== 2)));
        expect(onNewArrival).toHaveBeenCalledTimes(2);
        expect(badge()).toBe("1");
    });

    it("reports every row of a batch, oldest first, and skips coalesced repeats", async () => {
        const onNewArrival = vi.fn();
        let setRows: (f: (p: AppNotification[]) => AppNotification[]) => void = () => {};
        function Harness() {
            const [rows, s] = useState<AppNotification[]>([]);
            setRows = s;
            return (
                <NotificationBell
                    notifications={rows}
                    onDismiss={() => {}}
                    onClearAll={() => {}}
                    onNewArrival={onNewArrival}
                />
            );
        }
        render(<Harness />);
        // Two pushes in one commit — e.g. a stderr batch of 2 lines.
        await act(async () =>
            setRows(() => [entry(2, "second", Date.now()), entry(1, "first", Date.now())]),
        );
        expect(onNewArrival.mock.calls.map((c) => c[0].text)).toEqual(["first", "second"]);

        // Same id, count bumped — the store's coalesced repeat.
        await act(async () =>
            setRows(([head, ...rest]) => (head ? [{ ...head, count: 2 }, ...rest] : rest)),
        );
        expect(onNewArrival).toHaveBeenCalledTimes(2);
    });

    it("leaves toasted rows out of its own live region", async () => {
        // A client row gets a toast whose role="alert" already announces it;
        // the bell only voices the rows nothing else will.
        let setRows: (f: (p: AppNotification[]) => AppNotification[]) => void = () => {};
        function Harness() {
            const [rows, s] = useState<AppNotification[]>([]);
            setRows = s;
            return (
                <NotificationBell
                    notifications={rows}
                    onDismiss={() => {}}
                    onClearAll={() => {}}
                    onNewArrival={() => {}}
                />
            );
        }
        render(<Harness />);
        const status = () => document.querySelector('[role="status"]')?.textContent;

        await act(async () => setRows(() => [entry(1, "clicked", Date.now())]));
        expect(status()).toBe("");
        await act(async () => setRows((p) => [entry(2, "daemon", Date.now(), 1, "sidecar"), ...p]));
        expect(status()).toBe("daemon");
    });

    it("carries the unread count in the trigger's accessible name", () => {
        render(
            <NotificationBell
                notifications={[entry(1, "boom", Date.now()), entry(2, "bang", Date.now())]}
                onDismiss={() => {}}
                onClearAll={() => {}}
            />,
        );

        expect(screen.getByRole("button", { name: /app\.notificationsUnread:2/ })).not.toBeNull();
    });
});

describe("formatNotificationStamp", () => {
    const now = new Date(2026, 9, 10, 12, 0, 0).getTime();

    it("shows the bare clock for today", () => {
        const at = new Date(2026, 9, 10, 9, 5, 3).getTime();
        expect(formatNotificationStamp(at, now)).toBe("09:05:03");
    });

    it("prefixes the date once the row is from another day", () => {
        // The list outlives a session, so yesterday's failure must not look
        // like it just happened.
        const at = new Date(2026, 9, 9, 23, 59, 59).getTime();
        expect(formatNotificationStamp(at, now)).toBe("10/9 23:59:59");
    });
});
