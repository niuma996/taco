/**
 * PolicyExecutionDirPicker — the three ways a channel's tools pick a
 * working directory.
 *
 * One choice, one meaning: the previous model split this into a "binding"
 * plus a "per-chat scratch" flag, so two independent settings could both
 * claim the same outcome.
 *
 * Rendered as the same dropdown as the other policy fields; the custom mode
 * reveals a path input below it.
 */

import type { ImExecutionDir, ImExecutionDirMode } from "@taco-ai/protocol";
import { Select } from "../ui/Select.tsx";
import { TextInput } from "../ui/TextInput.tsx";

export interface PolicyExecutionDirPickerProps {
    value: ImExecutionDir;
    /** Mode the parent layer supplies — tagged in the list. */
    inheritedMode: ImExecutionDirMode;
    inheritedBadge: string;
    onModeChange: (mode: ImExecutionDirMode) => void;
    onPathChange: (path: string) => void;
    disabled: boolean;
    labels: {
        field: string;
        shared: string;
        perChat: string;
        custom: string;
        pathPlaceholder: string;
    };
}

const MODES: readonly ImExecutionDirMode[] = ["shared", "per-chat", "custom"];

function isMode(value: string): value is ImExecutionDirMode {
    return (MODES as readonly string[]).includes(value);
}

export function PolicyExecutionDirPicker(props: PolicyExecutionDirPickerProps): React.ReactElement {
    const { value, inheritedMode, inheritedBadge, onModeChange, onPathChange, disabled, labels } =
        props;
    const labelFor = (mode: ImExecutionDirMode): string => {
        if (mode === "shared") return labels.shared;
        if (mode === "per-chat") return labels.perChat;
        return labels.custom;
    };

    return (
        <div className="im-policy-dir">
            <Select
                value={value.mode}
                onValueChange={(next) => {
                    if (isMode(next)) onModeChange(next);
                }}
                disabled={disabled}
                label={labels.field}
                className="im-policy-select"
                options={MODES.map((mode) => ({
                    value: mode,
                    label: labelFor(mode),
                    ...(mode === inheritedMode ? { badge: inheritedBadge } : {}),
                }))}
            />
            {value.mode === "custom" && (
                <TextInput
                    type="text"
                    value={value.path ?? ""}
                    disabled={disabled}
                    placeholder={labels.pathPlaceholder}
                    aria-label={labels.custom}
                    onChange={(e) => onPathChange(e.target.value)}
                />
            )}
        </div>
    );
}
