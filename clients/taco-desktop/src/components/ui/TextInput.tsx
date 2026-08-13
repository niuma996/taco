/**
 * TextInput — shared text/password input. Applies the ui-input visual
 * language (border, radius, focus ring) from ui.css; callers pass any
 * native <input> prop. React 19 ref-as-prop passes through automatically.
 */
import type { ComponentPropsWithRef } from "react";

export type TextInputProps = ComponentPropsWithRef<"input">;

export function TextInput({ className, ...rest }: TextInputProps) {
    return <input className={className ? `ui-input ${className}` : "ui-input"} {...rest} />;
}
