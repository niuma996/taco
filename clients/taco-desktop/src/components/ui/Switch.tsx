/**
 * Switch — shared on/off toggle built on @radix-ui/react-switch.
 *
 * Wraps the Radix primitive so the whole desktop app draws one switch
 * visual language (track + thumb, brand-orange when on). Callers only pass
 * controlled state + an onChange callback; the Radix root carries the
 * role="switch" / aria-checked semantics and Space-to-toggle keyboard
 * handling.
 */
import * as SwitchPrimitive from "@radix-ui/react-switch";
import type { ComponentPropsWithoutRef } from "react";

export interface SwitchProps
    extends Omit<
        ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>,
        "onCheckedChange" | "onChange"
    > {
    label: string;
    onChange: (next: boolean) => void;
}

export function Switch(props: SwitchProps) {
    const { label, onChange, ...rest } = props;
    return (
        <SwitchPrimitive.Root
            {...rest}
            className="ui-switch"
            aria-label={label}
            onCheckedChange={onChange}
        >
            <SwitchPrimitive.Thumb className="ui-switch-thumb" />
        </SwitchPrimitive.Root>
    );
}
