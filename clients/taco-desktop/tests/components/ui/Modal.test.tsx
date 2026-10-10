/**
 * Modal — base component test.
 *
 * Locks the shared dialog shell's dismiss contract: Escape and scrim clicks
 * route through onClose, `dismissible={false}` swallows both, and focus
 * returns to the pre-open element on close. Also verifies the optional
 * description is wired via aria-describedby and absent otherwise.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Modal, type ModalProps } from "../../../src/components/ui/Modal";

afterEach(cleanup);

function renderModal(props: Partial<ModalProps> = {}) {
    return render(
        <Modal open onClose={vi.fn()} title="Test dialog" {...props}>
            <p>body</p>
        </Modal>,
    );
}

describe("Modal", () => {
    it("calls onClose on Escape", async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();
        renderModal({ onClose });
        await screen.findByRole("dialog");
        await user.keyboard("{Escape}");
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("calls onClose when the scrim is clicked", async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();
        renderModal({ onClose });
        await screen.findByRole("dialog");
        // Portal renders into document.body; the scrim is the backdrop sibling.
        const scrim = document.body.querySelector(".ui-modal-backdrop");
        expect(scrim).not.toBeNull();
        await user.click(scrim as Element);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("ignores Escape and scrim clicks when dismissible is false", async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();
        renderModal({ onClose, dismissible: false });
        await screen.findByRole("dialog");
        await user.keyboard("{Escape}");
        const scrim = document.body.querySelector(".ui-modal-backdrop");
        await user.click(scrim as Element);
        expect(onClose).not.toHaveBeenCalled();
    });

    it("renders the actions row when actions are passed", async () => {
        renderModal({ actions: <button type="button">OK</button> });
        await screen.findByRole("dialog");
        expect(document.body.querySelector(".ui-modal-actions")).not.toBeNull();
    });

    it("renders no actions row when actions are omitted", async () => {
        renderModal();
        await screen.findByRole("dialog");
        expect(document.body.querySelector(".ui-modal-actions")).toBeNull();
    });

    it("links the description via aria-describedby when provided", async () => {
        renderModal({ description: "details" });
        const dialog = await screen.findByRole("dialog");
        const id = dialog.getAttribute("aria-describedby");
        expect(id).toBeTruthy();
        expect(document.getElementById(id as string)?.textContent).toBe("details");
    });

    it("omits aria-describedby when no description is provided", async () => {
        renderModal();
        const dialog = await screen.findByRole("dialog");
        expect(dialog.getAttribute("aria-describedby")).toBeNull();
    });

    it("restores focus to the previously focused element on close", async () => {
        const user = userEvent.setup();
        function Harness() {
            const [open, setOpen] = useState(false);
            return (
                <>
                    <button type="button" onClick={() => setOpen(true)}>
                        open
                    </button>
                    <Modal open={open} onClose={() => setOpen(false)} title="t">
                        <button type="button">inside</button>
                    </Modal>
                </>
            );
        }
        render(<Harness />);
        const trigger = screen.getByRole("button", { name: "open" });
        // happy-dom does not focus buttons on click — focus explicitly so
        // Radix records the trigger as the element to restore.
        trigger.focus();
        await user.click(trigger);
        const dialog = await screen.findByRole("dialog");
        expect(dialog.contains(document.activeElement)).toBe(true);
        await user.keyboard("{Escape}");
        expect(screen.queryByRole("dialog")).toBeNull();
        // FocusScope restores focus in a setTimeout(0) after unmount.
        await waitFor(() => expect(document.activeElement).toBe(trigger));
    });
});
