/**
 * useWorkspaces notification store — the list behind the topbar bell.
 *
 * The old error banner showed one message at a time, so a sidecar re-emitting
 * the same `[error]` line per tick cost the user nothing. A list that appends
 * every push would bury the message the user actually needs under 49 copies,
 * so coalescing is load-bearing rather than cosmetic: these tests pin it.
 *
 * Run:
 *   pnpm --filter @taco-ai/desktop exec vitest run tests/hooks/useWorkspacesNotifications.test.tsx
 */

import { strict as assert } from "node:assert";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, it, vi } from "vitest";
import { ToastProvider } from "../../src/components/ToastProvider";
import { useWorkspaces } from "../../src/hooks/useWorkspaces";
import type { TacoClient } from "../../src/lib/clients/tacoClient.ts";

vi.mock("../../src/lib/workspaceStorage.ts", () => ({
    initDefaultCwd: vi.fn(async () => "/ws"),
    isValidWorkspaceCwd: vi.fn(() => true),
    loadActiveCwd: vi.fn(async () => null),
    loadOpenedCwds: vi.fn(async () => []),
    persistActiveCwd: vi.fn(async () => {}),
    persistCwds: vi.fn(async () => {}),
    pruneMissingCwds: vi.fn(async (cwds: string[]) => cwds),
    resolveActiveCwd: vi.fn(() => "/ws"),
}));

vi.mock("../../src/hooks/useSidecarStream.ts", () => ({
    sidecarLogListenerReady: Promise.resolve(),
}));

function makeClient() {
    return {
        start: vi.fn(async () => ({})),
        sessionList: vi.fn(async () => ({ sessions: [], total: 0 })),
        onWorkspaceEpochChanged: vi.fn(() => () => {}),
    };
}

function renderStore() {
    const client = makeClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
        <ToastProvider>{children}</ToastProvider>
    );
    return renderHook(() => useWorkspaces(client as unknown as TacoClient), { wrapper });
}

describe("useWorkspaces — notification list", () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it("coalesces a repeated message into one counted row", async () => {
        const { result } = renderStore();

        await act(async () => {
            result.current.pushNotification("disk is full");
        });
        await act(async () => {
            result.current.pushNotification("disk is full");
        });
        await act(async () => {
            result.current.pushNotification("disk is full");
        });

        assert.equal(result.current.notifications.length, 1);
        assert.equal(result.current.notifications[0]?.count, 3);
    });

    it("keeps distinct messages as distinct rows, newest first", async () => {
        const { result } = renderStore();

        await act(async () => {
            result.current.pushNotification("first");
        });
        await act(async () => {
            result.current.pushNotification("second");
        });

        assert.deepEqual(
            result.current.notifications.map((n) => n.text),
            ["second", "first"],
        );
        assert.equal(result.current.notifications[0]?.count, 1);
    });

    it("does not coalesce across kinds", async () => {
        // Same text from two sources is two facts: the onboarding modal filters
        // on `workspace-open`, so merging it into a generic row would make the
        // failure invisible there.
        const { result } = renderStore();

        await act(async () => {
            result.current.pushNotification("boom", { kind: "generic" });
        });
        await act(async () => {
            result.current.pushNotification("boom", { kind: "workspace-open" });
        });

        assert.equal(result.current.notifications.length, 2);
        assert.equal(result.current.notifications[0]?.kind, "workspace-open");
        assert.equal(result.current.notifications[1]?.count, 1);
    });

    it("stops coalescing once the window has passed", async () => {
        vi.useFakeTimers();
        try {
            const { result } = renderStore();

            await act(async () => {
                result.current.pushNotification("retrying");
            });
            await act(async () => {
                vi.advanceTimersByTime(11_000);
            });
            await act(async () => {
                result.current.pushNotification("retrying");
            });

            // Same text, but far enough apart to be two real occurrences.
            assert.equal(result.current.notifications.length, 2);
        } finally {
            vi.useRealTimers();
        }
    });

    it("caps the list and drops the oldest", async () => {
        const { result } = renderStore();

        await act(async () => {
            for (let i = 0; i < 60; i++) {
                result.current.pushNotification(`message ${i}`);
            }
        });

        assert.equal(result.current.notifications.length, 50);
        assert.equal(result.current.notifications[0]?.text, "message 59");
        assert.equal(result.current.notifications[49]?.text, "message 10");
    });

    it("dismisses one row and clears the rest without touching the other", async () => {
        const { result } = renderStore();

        await act(async () => {
            result.current.pushNotification("keep me");
        });
        await act(async () => {
            result.current.pushNotification("drop me", { kind: "workspace-open" });
        });
        const dropId = result.current.notifications[0]?.id ?? 0;

        await act(async () => {
            result.current.dismissNotification(dropId);
        });

        // The onboarding path drops exactly the banner it rendered; the rest of
        // the history the user has not read yet must survive.
        assert.deepEqual(
            result.current.notifications.map((n) => n.text),
            ["keep me"],
        );

        await act(async () => {
            result.current.clearNotifications();
        });
        assert.deepEqual(result.current.notifications, []);
    });

    it("hands out ids that stay unique as the list churns", async () => {
        // Ids key the rows. A module-level counter is shared by every mounted
        // hook (and survives HMR), so it has to be per-instance; what actually
        // matters is that no two live rows ever share an id.
        const { result } = renderStore();

        await act(async () => {
            for (let i = 0; i < 20; i++) {
                result.current.pushNotification(`message ${i}`);
                if (i % 3 === 0) {
                    const oldest =
                        result.current.notifications[result.current.notifications.length - 1];
                    if (oldest) result.current.dismissNotification(oldest.id);
                }
            }
        });

        const ids = result.current.notifications.map((n) => n.id);
        assert.equal(new Set(ids).size, ids.length);
    });
});
