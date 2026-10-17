import type { CommandPermissionRequest } from "@taco-ai/protocol";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PendingPermissionsModal } from "../../src/components/PendingPermissionsModal";

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

describe("PendingPermissionsModal", () => {
    it("identifies an unnamed originating session by its short id", () => {
        const request = {
            requestId: "r1",
            sessionId: "abcdef123456",
            toolCallId: "t1",
            command: "git push",
            evaluation: {
                behavior: "ask",
                risk: "externalSideEffect",
                reason: "may change remote state",
            },
        } as unknown as CommandPermissionRequest;

        render(
            <PendingPermissionsModal
                open
                onClose={() => {}}
                requests={{ r1: request }}
                sessions={[]}
                onResolve={() => {}}
            />,
        );

        expect(screen.getByText("session.pendingPermissionsFrom: abcdef12")).toBeTruthy();
    });
});
