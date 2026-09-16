/**
 * ToolCardShell region resolution — the shell owns every region and resolves
 * each against the tool's registry entry.
 *
 * Covers: unregistered tools get both defaults; a spec's body replaces the
 * default body; a null summary suppresses the head digest; the raw-args toggle
 * is present on every card whatever its regions chose; and the shell view now
 * actually renders (it was registered under a tool name that never existed).
 */
import { strict as assert } from "node:assert";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, it } from "vitest";

import { ToolCardShell } from "../../../src/components/ToolCardShell";
import "../../../src/components/toolViews/index.ts";
import type { UiToolCall } from "../../../src/lib/chat/chatUtils";

function call(overrides: Partial<UiToolCall> = {}): UiToolCall {
    return { id: "c1", name: "unregisteredTool", args: {}, status: "ok", ...overrides };
}

describe("ToolCardShell regions", () => {
    afterEach(cleanup);

    it("uses both defaults for an unregistered tool", () => {
        render(<ToolCardShell tool={call({ args: { path: "src/a.ts" }, resultText: "done" })} />);

        assert.ok(screen.getByText("unregisteredTool"));
        // Default summary guesses `path`; default body prints the result text.
        assert.ok(screen.getByText("src/a.ts"));
        assert.ok(screen.getByText("done"));
    });

    it("renders the shell view's command block and suppresses the head digest", () => {
        const { container } = render(
            <ToolCardShell
                tool={call({ name: "shell", args: { command: "ls -la" }, resultText: "a\nb" })}
            />,
        );

        // Body override renders the terminal-style command line…
        assert.ok(container.querySelector(".tool-card-shell-cmd"));
        assert.ok(screen.getByText("ls -la"));
        // …and the head no longer repeats the command as a summary.
        assert.equal(container.querySelector(".tool-card-summary"), null);
    });

    it("shows the pattern in the head for grep (summary-only spec)", () => {
        const { container } = render(
            <ToolCardShell
                tool={call({
                    name: "grep",
                    args: { pattern: "createReadTool", path: "src" },
                    resultText: "src/a.ts:1:createReadTool",
                })}
            />,
        );

        assert.equal(
            container.querySelector(".tool-card-summary")?.textContent,
            "createReadTool · src",
        );
        // No body override: the default body still prints the match list.
        assert.ok(screen.getByText("src/a.ts:1:createReadTool"));
    });

    it("keeps the status icon and name fixed even for overriding tools", () => {
        const { container } = render(
            <ToolCardShell
                tool={call({ name: "shell", args: { command: "x" }, status: "error" })}
            />,
        );

        assert.ok(container.querySelector(".tool-card.error"));
        assert.ok(container.querySelector(".tool-card-icon--error"));
        assert.ok(screen.getByText("shell"));
    });

    it("appends caller children below the body", () => {
        const { container } = render(
            <ToolCardShell tool={call({ resultText: "body text" })}>
                <div className="extra-slot">permission</div>
            </ToolCardShell>,
        );

        const card = container.querySelector(".tool-card");
        const children = Array.from(card?.children ?? []);
        const bodyIndex = children.findIndex((c) => c.classList.contains("tool-card-result"));
        const extraIndex = children.findIndex((c) => c.classList.contains("extra-slot"));
        assert.ok(bodyIndex >= 0 && extraIndex > bodyIndex, "children must follow the body");
    });
});

describe("ToolCardShell raw args", () => {
    afterEach(cleanup);

    it("stays collapsed until the toggle is clicked", async () => {
        const { container } = render(
            <ToolCardShell tool={call({ args: { path: "src/a.ts", limit: 20 } })} />,
        );

        assert.equal(container.querySelector(".tool-card-raw"), null);

        const toggle = container.querySelector(".tool-card-raw-toggle");
        assert.ok(toggle, "every card with args gets a toggle");
        assert.equal(toggle?.getAttribute("aria-expanded"), "false");

        await userEvent.setup().click(toggle as Element);

        assert.equal(toggle?.getAttribute("aria-expanded"), "true");
        // Pretty-printed, so both keys survive the round trip.
        const raw = container.querySelector(".tool-card-raw")?.textContent ?? "";
        assert.ok(raw.includes('"path": "src/a.ts"'), raw);
        assert.ok(raw.includes('"limit": 20'), raw);
    });

    it("collapses again on a second click", async () => {
        const { container } = render(<ToolCardShell tool={call({ args: { a: 1 } })} />);
        const toggle = container.querySelector(".tool-card-raw-toggle") as Element;
        const user = userEvent.setup();

        await user.click(toggle);
        assert.ok(container.querySelector(".tool-card-raw"));
        await user.click(toggle);
        assert.equal(container.querySelector(".tool-card-raw"), null);
    });

    it("is reachable on cards whose summary is suppressed", async () => {
        // shell's spec returns a null summary, so the toggle is the only way to
        // see the arguments the model actually sent.
        const { container } = render(
            <ToolCardShell
                tool={call({ name: "shell", args: { command: "ls -la", timeout: 5000 } })}
            />,
        );

        assert.equal(container.querySelector(".tool-card-summary"), null);
        await userEvent.setup().click(container.querySelector(".tool-card-raw-toggle") as Element);
        assert.ok(
            container.querySelector(".tool-card-raw")?.textContent?.includes('"timeout": 5000'),
        );
    });

    it("renders the raw block above the body", async () => {
        const { container } = render(
            <ToolCardShell tool={call({ args: { a: 1 }, resultText: "output" })} />,
        );
        await userEvent.setup().click(container.querySelector(".tool-card-raw-toggle") as Element);

        const children = Array.from(container.querySelector(".tool-card")?.children ?? []);
        const rawIndex = children.findIndex((c) => c.classList.contains("tool-card-raw"));
        const bodyIndex = children.findIndex((c) => c.classList.contains("tool-card-result"));
        assert.ok(
            rawIndex >= 0 && bodyIndex > rawIndex,
            "raw args belong with the head, above output",
        );
    });

    it("omits the toggle when there are no args", () => {
        const { container } = render(<ToolCardShell tool={call({ args: undefined })} />);
        assert.equal(container.querySelector(".tool-card-raw-toggle"), null);
    });

    it("falls back to String() for unserialisable args", async () => {
        const cyclic: Record<string, unknown> = { name: "loop" };
        cyclic.self = cyclic;

        const { container } = render(<ToolCardShell tool={call({ args: cyclic })} />);
        await userEvent.setup().click(container.querySelector(".tool-card-raw-toggle") as Element);

        // JSON.stringify throws on the cycle; the card must still show something.
        assert.ok((container.querySelector(".tool-card-raw")?.textContent ?? "").length > 0);
    });
});
