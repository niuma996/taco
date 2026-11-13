import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Message } from "../../src/components/Message";
import type { UiMessage } from "../../src/lib/chat/chatUtils";

vi.mock("../../src/i18n/useI18n", () => ({
    useT: () => ({ t: (key: string) => key }),
}));

afterEach(cleanup);

describe("agent message labels", () => {
    for (const relation of ["parent", "peer"]) {
        it(`labels ${relation} agent provenance separately from the body`, () => {
            const m = {
                id: "delivery",
                kind: "user",
                text: "continue",
                ts: 1000,
                agentProvenance: { senderSessionId: "sender", relation },
            } as UiMessage;
            render(<Message m={m} />);
            expect(screen.getByText(`message.${relation}Agent`)).toBeTruthy();
            expect(screen.getByText("continue").className).toBe("message-text");
            expect(screen.getByText("sender")).toBeTruthy();
        });
    }

    it("does not add an agent label to human input", () => {
        render(<Message m={{ id: "human", kind: "user", text: "continue", ts: 1000 }} />);
        expect(screen.queryByText("message.parentAgent")).toBeNull();
        expect(screen.queryByText("message.peerAgent")).toBeNull();
    });
});
