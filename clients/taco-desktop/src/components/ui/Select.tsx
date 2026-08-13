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

export type SelectOption = { value: string; label: string };

export interface SelectProps {
    value: string;
    onValueChange: (value: string) => void;
    options: ReadonlyArray<string | SelectOption>;
    placeholder?: string;
    disabled?: boolean;
    /** aria-label on the trigger. */
    label?: string;
}

export function Select(props: SelectProps): ReactElement {
    const { value, onValueChange, options, placeholder, disabled, label } = props;
    return (
        <SelectPrimitive.Root value={value} onValueChange={onValueChange} disabled={disabled}>
            <SelectPrimitive.Trigger className="ui-select-trigger" aria-label={label}>
                <SelectPrimitive.Value placeholder={placeholder} />
                <SelectPrimitive.Icon className="ui-select-caret" asChild>
                    <ChevronDown size={14} aria-hidden="true" />
                </SelectPrimitive.Icon>
            </SelectPrimitive.Trigger>
            <SelectPrimitive.Portal>
                <SelectPrimitive.Content
                    className="ui-select-content"
                    position="popper"
                    sideOffset={4}
                >
                    <SelectPrimitive.Viewport>
                        {options.map((opt) => {
                            const value = typeof opt === "string" ? opt : opt.value;
                            const text = typeof opt === "string" ? opt : opt.label;
                            return (
                                <SelectPrimitive.Item
                                    key={value}
                                    value={value}
                                    className="ui-select-item"
                                >
                                    <SelectPrimitive.ItemText>{text}</SelectPrimitive.ItemText>
                                    <SelectPrimitive.ItemIndicator className="ui-select-item-check">
                                        <Check size={12} aria-hidden="true" />
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
