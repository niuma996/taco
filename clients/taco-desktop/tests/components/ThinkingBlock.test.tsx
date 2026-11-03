/**
 * ThinkingBlock — the collapsible reasoning block inside an assistant message.
 *
 * Covers the state machine the collapse animation depends on: a streaming
 * block opens and auto-collapses when the turn ends, a manual toggle wins
 * over the default until the block's end time lands, and the body stays
 * mounted across the collapse so the height can transition rather than
 * vanish in one frame.
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Message } from "../../src/components/Message";
import * as useI18n from "../../src/i18n/useI18n";
import type { UiMessage, UiThinkingBlock } from "../../src/lib/chat/chatUtils";

vi.spyOn(useI18n, "useT").mockReturnValue({
    t: (key: string) => key,
} as unknown as ReturnType<typeof useI18n.useT>);

afterEach(cleanup);

function block(overrides: Partial<UiThinkingBlock> = {}): UiThinkingBlock {
    return { thinking: "reasoning text", startedAt: 0, ...overrides };
}

function assistant(thinking: UiThinkingBlock[]): UiMessage {
    return { id: "a1", kind: "assistant", text: "", ts: 0, tools: [], thinking };
}

/** The collapse wrapper, when the block has a body at all. */
function collapse(container: HTMLElement): HTMLElement | null {
    return container.querySelector(".ui-collapse");
}

describe("ThinkingBlock", () => {
    it("keeps the body mounted and collapses it when the turn ends", async () => {
        const { container, rerender } = render(
            <Message m={assistant([block({ endedAt: undefined })])} />,
        );

        // Streaming: open, body present, collapse track expanded.
        const el = collapse(container);
        expect(el).not.toBeNull();
        expect(el?.getAttribute("data-open")).toBe("true");
        expect(container.querySelector(".thinking-body")?.textContent).toBe("reasoning text");

        // The turn ends: the block auto-collapses, but the body stays mounted
        // so the height has something to transition.
        rerender(<Message m={assistant([block({ endedAt: 5 })])} />);

        expect(collapse(container)?.getAttribute("data-open")).toBe("false");
        expect(container.querySelector(".thinking-body")?.textContent).toBe("reasoning text");
    });

    it("lets a manual toggle override the default open state", async () => {
        const { container } = render(<Message m={assistant([block({ endedAt: undefined })])} />);

        const header = screen.getByRole("button", { name: /message\.thinkingStreaming/ });
        expect(header.getAttribute("aria-expanded")).toBe("true");

        await userEvent.setup({ delay: null }).click(header);

        // Collapsed by hand while streaming.
        expect(header.getAttribute("aria-expanded")).toBe("false");
        expect(collapse(container)?.getAttribute("data-open")).toBe("false");
        // Still mounted — the collapse is a height transition, not an unmount.
        expect(container.querySelector(".thinking-body")).not.toBeNull();
    });

    it("re-applies the default when the block ends, overriding a manual toggle", async () => {
        const { container, rerender } = render(
            <Message m={assistant([block({ endedAt: undefined })])} />,
        );

        const header = screen.getByRole("button", { name: /message\.thinkingStreaming/ });
        await userEvent.setup({ delay: null }).click(header);
        expect(header.getAttribute("aria-expanded")).toBe("false");

        rerender(<Message m={assistant([block({ endedAt: 5 })])} />);

        // The default flipped to closed, so the block stays closed — and the
        // header's label switches to the completed wording.
        expect(collapse(container)?.getAttribute("data-open")).toBe("false");
        expect(screen.getByRole("button", { name: /message\.thinkingDuration/ })).toBeTruthy();
    });

    it("renders no body for a redacted block", () => {
        const { container } = render(<Message m={assistant([block({ redacted: true })])} />);

        expect(collapse(container)).toBeNull();
        expect(screen.getByRole("button", { name: /message\.thinkingRedacted/ })).toBeTruthy();
    });

    it("keeps a historical block closed but mounted once opened", async () => {
        const { container } = render(
            <Message m={assistant([block({ isHistorical: true, endedAt: 5 })])} />,
        );

        // Historical blocks start closed and render no body at all — the
        // common case in a long transcript, so nothing is paid for them.
        expect(collapse(container)).toBeNull();

        const header = screen.getByRole("button", { name: /message\.thinkingDone/ });
        await userEvent.setup({ delay: null }).click(header);

        expect(collapse(container)?.getAttribute("data-open")).toBe("true");
        expect(container.querySelector(".thinking-body")?.textContent).toBe("reasoning text");
    });
});
