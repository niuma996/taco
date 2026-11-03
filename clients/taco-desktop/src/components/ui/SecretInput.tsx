/**
 * SecretInput — password input with an eye toggle that switches between
 * masked and plaintext display. Wraps TextInput; the toggle is an IconButton
 * overlaid at the trailing edge. Caller owns the value; visibility state is
 * internal (each mount starts masked).
 *
 * i18n: callers pass `revealLabel` / `hideLabel` (aria-label + title).
 */
import { Eye, EyeOff } from "lucide-react";
import { type ComponentPropsWithRef, useState } from "react";
import { IconButton } from "./IconButton.tsx";
import { IconSwap } from "./IconSwap.tsx";
import { TextInput } from "./TextInput.tsx";

export interface SecretInputProps extends ComponentPropsWithRef<"input"> {
    revealLabel: string;
    hideLabel: string;
}

export function SecretInput({ revealLabel, hideLabel, ...rest }: SecretInputProps) {
    const [visible, setVisible] = useState(false);
    return (
        <span className="ui-secret-input">
            <TextInput type={visible ? "text" : "password"} {...rest} />
            <IconButton
                size="sm"
                className="ui-secret-input-toggle"
                aria-label={visible ? hideLabel : revealLabel}
                title={visible ? hideLabel : revealLabel}
                aria-pressed={visible}
                onClick={() => setVisible((v) => !v)}
            >
                <IconSwap
                    icons={[
                        <Eye size={13} key="hidden" aria-hidden="true" />,
                        <EyeOff size={13} key="visible" aria-hidden="true" />,
                    ]}
                    active={visible ? 1 : 0}
                />
            </IconButton>
        </span>
    );
}
