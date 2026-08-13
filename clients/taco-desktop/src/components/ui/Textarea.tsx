/**
 * Textarea — shared multi-line input. Same ui-input visual language as
 * TextInput; the textarea variant keeps its mono font for the model-list
 * use cases and stays vertically resizable.
 */
import type { ComponentPropsWithRef } from "react";

export type TextareaProps = ComponentPropsWithRef<"textarea">;

export function Textarea({ className, ...rest }: TextareaProps) {
    return (
        <textarea
            className={className ? `ui-input ui-textarea ${className}` : "ui-input ui-textarea"}
            {...rest}
        />
    );
}
