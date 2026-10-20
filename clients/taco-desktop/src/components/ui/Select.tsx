/**
 * Select — shared dropdown backed by @radix-ui/react-select.
 *
 * The project convention (CLAUDE.md) forbids native <select>: keyboard
 * navigation and item roles differ between Radix and native select. All
 * single-choice pickers go through this component. `options` may mix
 * string values and objects ({ value, label }); strings render verbatim.
 */
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import type { ReactElement } from "react";

export type SelectOption = {
    value: string;
    label: string;
    /** Short tag after the label (e.g. "Default"), shown in the list and the trigger. */
    badge?: string;
};

export interface SelectProps {
    value: string;
    onValueChange: (value: string) => void;
    options: ReadonlyArray<string | SelectOption>;
    placeholder?: string;
    disabled?: boolean;
    /** aria-label on the trigger. */
    label?: string;
    /** Feature modifier added to both the trigger and the (portalled) list. */
    className?: string;
    /** "menu": caret-less trigger whose list uses the shared `.ui-menu` look and opens upward. */
    variant?: "field" | "menu";
}

export function Select(props: SelectProps): ReactElement {
    const { value, onValueChange, options, placeholder, disabled, label, className } = props;
    const menu = props.variant === "menu";
    const withClass = (base: string): string => (className ? `${base} ${className}` : base);
    return (
        <SelectPrimitive.Root value={value} onValueChange={onValueChange} disabled={disabled}>
            <SelectPrimitive.Trigger className={withClass("ui-select-trigger")} aria-label={label}>
                <SelectPrimitive.Value placeholder={placeholder} />
                {!menu && (
                    <SelectPrimitive.Icon className="ui-select-caret" asChild>
                        <ChevronDown size={14} aria-hidden="true" />
                    </SelectPrimitive.Icon>
                )}
            </SelectPrimitive.Trigger>
            <SelectPrimitive.Portal>
                <SelectPrimitive.Content
                    className={withClass(menu ? "ui-menu" : "ui-select-content")}
                    position="popper"
                    side={menu ? "top" : "bottom"}
                    align={menu ? "start" : "center"}
                    sideOffset={menu ? 6 : 4}
                >
                    <SelectPrimitive.Viewport>
                        {options.map((opt) => {
                            const value = typeof opt === "string" ? opt : opt.value;
                            const text = typeof opt === "string" ? opt : opt.label;
                            const badge = typeof opt === "string" ? undefined : opt.badge;
                            return (
                                <SelectPrimitive.Item
                                    key={value}
                                    value={value}
                                    className={menu ? "ui-menu-item" : "ui-select-item"}
                                >
                                    {/* The badge sits inside ItemText so Radix mirrors it into
                                        the trigger along with the label. */}
                                    <span className={menu ? "ui-menu-label" : undefined}>
                                        <SelectPrimitive.ItemText>
                                            {text}
                                            {badge !== undefined && (
                                                <span className="ui-select-item-badge">
                                                    {badge}
                                                </span>
                                            )}
                                        </SelectPrimitive.ItemText>
                                    </span>
                                    <SelectPrimitive.ItemIndicator className="ui-select-item-check">
                                        <Check size={menu ? 14 : 12} aria-hidden="true" />
                                    </SelectPrimitive.ItemIndicator>
                                </SelectPrimitive.Item>
                            );
                        })}
                    </SelectPrimitive.Viewport>
                </SelectPrimitive.Content>
            </SelectPrimitive.Portal>
        </SelectPrimitive.Root>
    );
}
