import type { CommandPermissionRequest } from "@taco-ai/protocol";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    collectPendingPermissions,
    PendingApprovalsPanel,
} from "../../src/components/PendingApprovalsPanel";
import type { WorkspaceState } from "../../src/lib/chat/workspaceReducer";

vi.mock("react-i18next", () => ({
    useTranslation: vi.fn(() => ({
        t: (key: string) => key,
        i18n: { language: "en" },
    })),
}));

afterEach(cleanup);
beforeEach(() => {
    document.body.innerHTML = "";
});

function request(requestId: string, sessionId: string, command: string): CommandPermissionRequest {
    return {
        requestId,
        sessionId,
        toolCallId: `t-${requestId}`,
        command,
        evaluation: {
            behavior: "ask",
            risk: "externalSideEffect",
            reason: "may change remote state",
        },
    } as unknown as CommandPermissionRequest;
}

function workspace(
    cwd: string,
    pending: CommandPermissionRequest[],
    sessions: { id: string; name?: string }[] = [],
): WorkspaceState {
    return {
        cwd,
        sessions,
        pendingCommandPermissions: Object.fromEntries(pending.map((r) => [r.requestId, r])),
    } as unknown as WorkspaceState;
}

describe("PendingApprovalsPanel", () => {
    const workspaces = {
        "/repos/alpha": workspace(
            "/repos/alpha",
            [request("r1", "s-alpha", "git push")],
            [{ id: "s-alpha", name: "Release" }],
        ),
        "/repos/beta": workspace("/repos/beta", [request("r2", "abcdef123456", "npm publish")]),
        "im://wechat/u1/c1": workspace("im://wechat/u1/c1", [request("r3", "s-im", "make")]),
        "/repos/idle": workspace("/repos/idle", []),
    };

    it("collects approvals from every workspace", () => {
        expect(
            collectPendingPermissions(workspaces).map((e) => [e.cwd, e.request.requestId]),
        ).toEqual([
            ["/repos/alpha", "r1"],
            ["/repos/beta", "r2"],
            ["im://wechat/u1/c1", "r3"],
        ]);
    });

    it("names the workspace and session of each request", async () => {
        const user = userEvent.setup();
        render(<PendingApprovalsPanel workspaces={workspaces} onResolve={() => {}} />);
        await user.click(screen.getByRole("button", { name: "session.pendingPermissions" }));

        expect(screen.getByText("session.pendingPermissionsFrom: alpha · Release")).toBeTruthy();
        expect(screen.getByText("session.pendingPermissionsFrom: beta · abcdef12")).toBeTruthy();
        expect(screen.getByText(/session\.pendingPermissionsFrom: wechat · /)).toBeTruthy();
    });

    it("resolves a request against the workspace it came from", async () => {
        const user = userEvent.setup();
        const onResolve = vi.fn();
        render(<PendingApprovalsPanel workspaces={workspaces} onResolve={onResolve} />);
        await user.click(screen.getByRole("button", { name: "session.pendingPermissions" }));

        const row = screen.getByText("npm publish").closest(".pending-approval") as HTMLElement;
        await user.click(row.querySelector(".permission-allow") as HTMLElement);
        expect(onResolve).toHaveBeenCalledWith("/repos/beta", "r2", true, "once");
    });

    it("stays open when a resolved request leaves other requests on screen", async () => {
        // The row that had focus is removed from the DOM once it resolves.
        // Focus falls back to the body, which Radix reads as focus leaving the
        // panel — it would close, hiding the requests still waiting.
        const user = userEvent.setup();
        function Harness() {
            const [pending, setPending] = useState([
                request("r1", "s-alpha", "git push"),
                request("r2", "abcdef123456", "npm publish"),
            ]);
            return (
                <PendingApprovalsPanel
                    workspaces={{
                        "/repos/alpha": workspace("/repos/alpha", pending),
                    }}
                    onResolve={(_cwd, requestId) =>
                        setPending((p) => p.filter((r) => r.requestId !== requestId))
                    }
                />
            );
        }
        render(<Harness />);
        await user.click(screen.getByRole("button", { name: "session.pendingPermissions" }));

        const row = screen.getByText("git push").closest(".pending-approval") as HTMLElement;
        await user.click(row.querySelector(".permission-allow") as HTMLElement);

        // The resolved row is gone, but the panel and the other request stay.
        expect(screen.queryByText("git push")).toBeNull();
        expect(screen.getByText("npm publish")).not.toBeNull();
    });

    it("shows the empty state when nothing is pending", async () => {
        const user = userEvent.setup();
        render(
            <PendingApprovalsPanel
                workspaces={{ "/repos/idle": workspaces["/repos/idle"] }}
                onResolve={() => {}}
            />,
        );
        await user.click(screen.getByRole("button", { name: "session.pendingPermissions" }));
        expect(screen.getByText("session.pendingPermissionsEmpty")).toBeTruthy();
    });

    it("hides the count badge when nothing is pending", () => {
        render(
            <PendingApprovalsPanel
                workspaces={{ "/repos/idle": workspaces["/repos/idle"] }}
                onResolve={() => {}}
            />,
        );

        const button = screen.getByRole("button", { name: "session.pendingPermissions" });
        expect(document.querySelector(".workspace-approval-button__count")).toBeNull();
        expect(button.className).not.toContain("workspace-approval-button--pending");
    });

    it("badges the number of pending approvals", () => {
        render(<PendingApprovalsPanel workspaces={workspaces} onResolve={() => {}} />);

        expect(document.querySelector(".workspace-approval-button__count")?.textContent).toBe("3");
    });
});
