/**
 * TextInput — base component test.
 *
 * Locks the ui-input class application and the ref-prop passthrough (React 19
 * ref as prop), so the migration from per-file input styles doesn't regress
 * the shared visual class or forwardRef behavior.
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, type RefObject } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TextInput } from "../../../src/components/ui/TextInput";

afterEach(cleanup);

describe("TextInput", () => {
    it("applies the ui-input class and passes native props", () => {
        render(<TextInput placeholder="Type here" />);
        const el = screen.getByPlaceholderText("Type here");
        expect(el.className).toContain("ui-input");
        expect((el as HTMLInputElement).type).toBe("text");
    });

    it("merges an extra className after ui-input", () => {
        render(<TextInput className="extra" />);
        expect((screen.getByRole("textbox") as HTMLInputElement).className).toBe("ui-input extra");
    });

    it("forwards the ref prop (React 19)", () => {
        const ref: RefObject<HTMLInputElement | null> = createRef<HTMLInputElement | null>();
        render(<TextInput ref={ref} />);
        expect(ref.current).toBeInstanceOf(HTMLInputElement);
    });

    it("fires onChange with the typed value", async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        render(<TextInput onChange={onChange} />);
        await user.type(screen.getByRole("textbox"), "abc");
        expect(onChange).toHaveBeenCalled();
        expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("abc");
    });
});
