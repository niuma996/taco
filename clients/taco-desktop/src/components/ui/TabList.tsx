import { type KeyboardEvent, type ReactNode, useId } from "react";

export interface TabItem<T extends string> {
    value: T;
    label: string;
    icon?: ReactNode;
    trailing?: ReactNode;
    id?: string;
    panelId?: string;
}

export interface TabListProps<T extends string> {
    label: string;
    value: T;
    items: readonly TabItem<T>[];
    onValueChange: (value: T) => void;
    variant?: "underline" | "segmented";
    className?: string;
}

/** Controlled horizontal tabs with one tab stop and activation on arrow-key focus. */
export function TabList<T extends string>({
    label,
    value,
    items,
    onValueChange,
    variant = "underline",
    className,
}: TabListProps<T>) {
    const generatedId = useId();
    if (items.length === 0) return null;
    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const tabs = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=tab]"),
        );
        const focused = tabs.indexOf(
            event.currentTarget.ownerDocument.activeElement as HTMLButtonElement,
        );
        const current =
            focused >= 0
                ? focused
                : Math.max(
                      0,
                      items.findIndex((item) => item.value === value),
                  );
        const next =
            event.key === "Home"
                ? 0
                : event.key === "End"
                  ? items.length - 1
                  : (current + (event.key === "ArrowRight" ? 1 : -1) + items.length) % items.length;
        const nextItem = items[next];
        if (nextItem) {
            tabs[next]?.focus();
            onValueChange(nextItem.value);
        }
    };
    return (
        <div
            role="tablist"
            aria-label={label}
            className={`ui-tabs ui-tabs--${variant}${className ? ` ${className}` : ""}`}
            onKeyDown={onKeyDown}
        >
            {items.map((item) => {
                const active = item.value === value;
                return (
                    <button
                        key={item.value}
                        type="button"
                        role="tab"
                        id={item.id ?? `${generatedId}-${item.value}`}
                        aria-selected={active}
                        aria-controls={item.panelId}
                        tabIndex={active ? 0 : -1}
                        className="ui-tabs__tab"
                        onClick={() => onValueChange(item.value)}
                    >
                        {item.icon}
                        <span>{item.label}</span>
                        {item.trailing}
                    </button>
                );
            })}
        </div>
    );
}
