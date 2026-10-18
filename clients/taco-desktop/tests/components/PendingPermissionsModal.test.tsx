import type { CommandPermissionRequest } from "@taco-ai/protocol";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    collectPendingPermissions,
    PendingPermissionsModal,
} from "../../src/components/PendingPermissionsModal";
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

describe("PendingPermissionsModal", () => {
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

    it("names the workspace and session of each request", () => {
        render(
            <PendingPermissionsModal
                open
                onClose={() => {}}
                workspaces={workspaces}
                onResolve={() => {}}
            />,
        );

        expect(screen.getByText("session.pendingPermissionsFrom: alpha · Release")).toBeTruthy();
        expect(screen.getByText("session.pendingPermissionsFrom: beta · abcdef12")).toBeTruthy();
        expect(screen.getByText(/session\.pendingPermissionsFrom: wechat · /)).toBeTruthy();
    });

    it("resolves a request against the workspace it came from", async () => {
        const user = userEvent.setup();
        const onResolve = vi.fn();
        render(
            <PendingPermissionsModal
                open
                onClose={() => {}}
                workspaces={workspaces}
                onResolve={onResolve}
            />,
        );

        const row = screen.getByText("npm publish").closest(".pending-permission") as HTMLElement;
        await user.click(row.querySelector(".permission-allow") as HTMLElement);
        expect(onResolve).toHaveBeenCalledWith("/repos/beta", "r2", true, "once");
    });

    it("shows the empty state when nothing is pending", () => {
        render(
            <PendingPermissionsModal
                open
                onClose={() => {}}
                workspaces={{ "/repos/idle": workspaces["/repos/idle"] }}
                onResolve={() => {}}
            />,
        );
        expect(screen.getByText("session.pendingPermissionsEmpty")).toBeTruthy();
    });
});
