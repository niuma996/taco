/**
 * `defaultCwdSettled` means "initDefaultCwd finished", not "it succeeded".
 *
 * App.tsx gates the OnboardingModal on this flag because the modal's
 * WorkspaceStep pre-fills from `getDefaultCwd()`, and `desktopConfig` loads on
 * a separate effect that can win the race — mounting earlier shows the empty
 * synchronous placeholder.
 *
 * The distinction is load-bearing. `initDefaultCwd` swallows a failing
 * `default_workspace_dir` call and keeps the empty fallback, so on a fresh
 * install `resolveActiveCwd` returns "" and `activeCwd` stays empty forever.
 * Gating on a non-empty cwd would therefore hide onboarding permanently, with
 * no path for the user to pick a directory by hand — a soft brick. The flag
 * must flip on the failure path too.
 *
 * Run:
 *   pnpm --filter @taco-ai/desktop exec vitest run tests/hooks/useWorkspacesDefaultCwdSettled.test.tsx
 */

import { strict as assert } from "node:assert";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, it, vi } from "vitest";
import { ToastProvider } from "../../src/components/ToastProvider";
import { useWorkspaces } from "../../src/hooks/useWorkspaces";
import type { TacoClient } from "../../src/lib/clients/tacoClient.ts";

/**
 * `initDefaultCwd` resolves to "" — the shape the real function returns when
 * the Tauri `default_workspace_dir` call throws and it keeps its fallback.
 * `resolveActiveCwd` mirrors production's `opened[0] ?? defaultCwd`, so with no
 * opened workspaces it yields "" too: the fresh-install failure case.
 */
vi.mock("../../src/lib/workspaceStorage.ts", () => ({
    initDefaultCwd: vi.fn(async () => ""),
    getDefaultCwd: vi.fn(() => ""),
    isValidWorkspaceCwd: vi.fn((cwd: string) => cwd !== ""),
    loadActiveCwd: vi.fn(async () => null),
    loadOpenedCwds: vi.fn(async () => []),
    persistActiveCwd: vi.fn(async () => {}),
    persistCwds: vi.fn(async () => {}),
    pruneMissingCwds: vi.fn(async (cwds: string[]) => cwds),
    resolveActiveCwd: vi.fn(() => ""),
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

describe("useWorkspaces — defaultCwdSettled", () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it("flips to true even when initDefaultCwd fails and leaves activeCwd empty", async () => {
        const client = makeClient();
        const wrapper = ({ children }: { children: ReactNode }) => (
            <ToastProvider>{children}</ToastProvider>
        );
        const { result } = renderHook(() => useWorkspaces(client as unknown as TacoClient), {
            wrapper,
        });

        // Starts false: nothing has resolved on the first render, so onboarding
        // must not mount yet.
        assert.equal(result.current.defaultCwdSettled, false);

        await act(async () => {
            await result.current.initFromStorage();
        });

        await waitFor(() => {
            assert.equal(result.current.defaultCwdSettled, true);
        });

        // The precondition that makes this test meaningful: the default really
        // did fail to resolve. If activeCwd were non-empty, gating on it would
        // have been sufficient and this flag would be redundant.
        assert.equal(
            result.current.activeCwd,
            "",
            "test fixture must reproduce the failure case (empty default cwd)",
        );
    });
});
