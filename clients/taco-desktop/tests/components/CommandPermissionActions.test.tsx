/**
 * Tool-card approval buttons are gated by the workspace pending table, not the
 * card's status: a background spawn's card is `ok` while its child still waits,
 * and an aborted turn's card must lose its buttons once the resolved push lands.
 */
import { strict as assert } from "node:assert";
import { asSessionId, asToolCallId, type CommandPermissionRequest } from "@taco-ai/protocol";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CommandPermissionPrompt } from "../../src/components/CommandPermissionPrompt";
import { Message } from "../../src/components/Message";
import * as useI18n from "../../src/i18n/useI18n";
import type { UiMessage, UiToolCall } from "../../src/lib/chat/chatUtils";

vi.spyOn(useI18n, "useT").mockReturnValue({
    t: (key: string) => key,
} as unknown as ReturnType<typeof useI18n.useT>);

afterEach(cleanup);

const request: CommandPermissionRequest = {
    requestId: "req-1",
    sessionId: asSessionId("s1"),
    toolCallId: asToolCallId("tc-1"),
    command: "rm -rf build",
    evaluation: { behavior: "ask", risk: "destructive", reason: "deletes a directory" },
};

function assistant(status: UiToolCall["status"]): UiMessage {
    return {
        id: "a1",
        kind: "assistant",
        text: "",
        ts: 1,
        thinking: [],
        tools: [
            {
                id: "tc-1",
                name: "agent",
                args: {},
                status,
                details: { commandPermission: request },
            },
        ],
    };
}

const allowOnce = () => screen.queryByText("settings.permissionsAllowOnce");

describe("CommandPermissionActions gate", () => {
    it("shows buttons on a settled card while the request is pending", () => {
        render(
            <Message
                m={assistant("ok")}
                onCommandPermission={() => {}}
                pendingPermissionRequests={{ "req-1": request }}
            />,
        );
        assert.ok(allowOnce());
    });

    it("hides buttons once the request leaves the table, even if the card is running", () => {
        render(
            <Message
                m={assistant("running")}
                onCommandPermission={() => {}}
                pendingPermissionRequests={{}}
            />,
        );
        assert.equal(allowOnce(), null);
    });

    it("falls back to card status when no table is supplied", () => {
        render(<Message m={assistant("running")} onCommandPermission={() => {}} />);
        assert.ok(allowOnce());
    });
});

describe("CommandPermissionPrompt persistent approvals", () => {
    it("allows persistent approval for a non-blacklisted command regardless of risk", () => {
        render(<CommandPermissionPrompt request={request} onResolve={() => {}} />);
        expect(
            (
                screen.getByRole("button", {
                    name: "settings.permissionsAlwaysAllow",
                }) as HTMLButtonElement
            ).disabled,
        ).toBe(false);
        expect(
            (
                screen.getByRole("button", {
                    name: "settings.permissionsAllowSession",
                }) as HTMLButtonElement
            ).disabled,
        ).toBe(false);
    });

    it("only offers one-time approval when a command matches the blacklist", () => {
        const blacklisted = {
            ...request,
            evaluation: {
                ...request.evaluation,
                risk: "readOnly" as const,
                matchedList: "deny" as const,
            },
        };
        render(<CommandPermissionPrompt request={blacklisted} onResolve={() => {}} />);
        expect(
            (
                screen.getByRole("button", {
                    name: "settings.permissionsAlwaysAllow",
                }) as HTMLButtonElement
            ).disabled,
        ).toBe(true);
        expect(
            (
                screen.getByRole("button", {
                    name: "settings.permissionsAllowSession",
                }) as HTMLButtonElement
            ).disabled,
        ).toBe(true);
        expect(
            (
                screen.getByRole("button", {
                    name: "settings.permissionsAllowOnce",
                }) as HTMLButtonElement
            ).disabled,
        ).toBe(false);
    });
});

it("disables persistent approval for unsupported syntax", () => {
    render(
        <CommandPermissionPrompt
            request={{
                ...request,
                evaluation: { ...request.evaluation, persistentAllowed: false },
            }}
            onResolve={() => {}}
        />,
    );
    expect(
        (
            screen.getByRole("button", {
                name: "settings.permissionsAlwaysAllow",
            }) as HTMLButtonElement
        ).disabled,
    ).toBe(true);
    expect(
        (
            screen.getByRole("button", {
                name: "settings.permissionsAllowSession",
            }) as HTMLButtonElement
        ).disabled,
    ).toBe(true);
});
