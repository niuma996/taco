/**
 * Switch — shared on/off toggle built on @radix-ui/react-switch.
 *
 * Wraps the Radix primitive so the whole desktop app draws one switch
 * visual language (track + thumb, brand-orange when on). Callers pass
 * controlled state + an onChange callback; the Radix root carries the
 * role="switch" / aria-checked semantics and Space-to-toggle keyboard
 * handling. `label` is the accessible name when no visible text names the
 * control. `labelledBy` points at that text instead, so a screen reader
 * does not read the name twice.
 */
import * as SwitchPrimitive from "@radix-ui/react-switch";
import type { ComponentPropsWithoutRef } from "react";

type SwitchName = { label: string; labelledBy?: never } | { labelledBy: string; label?: never };

export type SwitchProps = Omit<
    ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>,
    "onCheckedChange" | "onChange" | "aria-label" | "aria-labelledby"
> &
    SwitchName & {
        onChange: (next: boolean) => void;
    };

export function Switch(props: SwitchProps) {
    const { label, labelledBy, onChange, ...rest } = props;
    return (
        <SwitchPrimitive.Root
            {...rest}
            className="ui-switch"
            aria-label={labelledBy === undefined ? label : undefined}
            aria-labelledby={labelledBy}
            onCheckedChange={onChange}
        >
            <SwitchPrimitive.Thumb className="ui-switch-thumb" />
        </SwitchPrimitive.Root>
    );
}
