import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { TabList } from "../../../src/components/ui/TabList";

afterEach(cleanup);
const items = [
    { value: "a", label: "First", panelId: "first-panel" },
    { value: "b", label: "Second", panelId: "second-panel" },
    { value: "c", label: "Third", panelId: "third-panel" },
];

function ControlledTabs({ label }: { label: string }) {
    const [value, setValue] = useState("a");
    return <TabList label={label} items={items} value={value} onValueChange={setValue} />;
}

it("keeps focus, selection and generated identities local to each tab list", () => {
    render(
        <>
            <ControlledTabs label="Sources" />
            <ControlledTabs label="Other" />
        </>,
    );
    const sourceTabs = within(screen.getByRole("tablist", { name: "Sources" }));
    const otherTabs = within(screen.getByRole("tablist", { name: "Other" }));
    const first = sourceTabs.getByRole("tab", { name: "First" });
    const second = sourceTabs.getByRole("tab", { name: "Second" });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(document.activeElement).toBe(second);
    expect(second.getAttribute("aria-selected")).toBe("true");
    expect(second.getAttribute("aria-controls")).toBe("second-panel");
    const other = otherTabs.getByRole("tab", { name: "First" });
    expect(other.getAttribute("aria-selected")).toBe("true");
    expect(first.id).not.toBe(other.id);
});

it("navigates from the focused tab when controlled activation has not updated yet", () => {
    const onChange = vi.fn();
    render(<TabList label="Sources" items={items} value="a" onValueChange={onChange} />);
    const third = screen.getByRole("tab", { name: "Third" });
    third.focus();
    fireEvent.keyDown(third, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Second" }));
    expect(onChange).toHaveBeenCalledWith("b");
});

it("leaves modified browser navigation keys alone", () => {
    const onChange = vi.fn();
    render(<TabList label="Sources" items={items} value="a" onValueChange={onChange} />);
    const first = screen.getByRole("tab", { name: "First" });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight", ctrlKey: true });
    expect(onChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(first);
});
