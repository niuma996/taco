/**
 * PolicyExecutionDirPicker — the three ways a channel's tools pick a
 * working directory.
 *
 * One choice, one meaning: the previous model split this into a "binding"
 * plus a "per-chat scratch" flag, so two independent settings could both
 * claim the same outcome.
 */

import type { ImExecutionDir, ImExecutionDirMode } from "@taco-ai/protocol";
import { useId } from "react";
import { TextInput } from "../ui/TextInput.tsx";

export interface PolicyExecutionDirPickerProps {
    value: ImExecutionDir;
    onChange: (value: ImExecutionDir) => void;
    disabled: boolean;
    labels: {
        shared: string;
        perChat: string;
        custom: string;
        sharedHint: string;
        perChatHint: string;
        customHint: string;
        pathPlaceholder: string;
    };
    error?: string | null;
}

const MODES: readonly ImExecutionDirMode[] = ["shared", "per-chat", "custom"];

export function PolicyExecutionDirPicker(props: PolicyExecutionDirPickerProps): React.ReactElement {
    const { value, onChange, disabled, labels, error } = props;
    const groupName = useId();

    const hintFor = (mode: ImExecutionDirMode): string => {
        if (mode === "shared") return labels.sharedHint;
        if (mode === "per-chat") return labels.perChatHint;
        return labels.customHint;
    };
    const labelFor = (mode: ImExecutionDirMode): string => {
        if (mode === "shared") return labels.shared;
        if (mode === "per-chat") return labels.perChat;
        return labels.custom;
    };

    return (
        <div className="im-policy-dir">
            <div className="im-policy-dir-options" role="radiogroup">
                {MODES.map((mode) => {
                    const selected = value.mode === mode;
                    return (
                        <label
                            key={mode}
                            className={
                                selected
                                    ? "im-policy-dir-option is-selected"
                                    : "im-policy-dir-option"
                            }
                        >
                            <input
                                type="radio"
                                name={groupName}
                                value={mode}
                                checked={selected}
                                disabled={disabled}
                                onChange={() => onChange({ mode })}
                            />
                            <span className="im-policy-dir-option-body">
                                <span className="im-policy-dir-option-label">{labelFor(mode)}</span>
                                <span className="im-policy-dir-option-hint">{hintFor(mode)}</span>
                            </span>
                        </label>
                    );
                })}
            </div>
            {value.mode === "custom" && (
                <div className="im-policy-dir-path">
                    <TextInput
                        type="text"
                        value={value.path ?? ""}
                        disabled={disabled}
                        placeholder={labels.pathPlaceholder}
                        onChange={(e) => onChange({ mode: "custom", path: e.target.value })}
                    />
                </div>
            )}
            {error !== undefined && error !== null && (
                <span className="ui-form-error">{error}</span>
            )}
        </div>
    );
}
