/**
 * ThinkingSlider — discrete horizontal slider over THINKING_LEVELS.
 *
 * Renders the shared ui/Slider with one mark per level and a center-aligned
 * current-level label. The slider value is the level index; aria-valuetext
 * carries the level name. Left end = off, right end = highest.
 *
 * `levels` narrows the offered set — the auxiliary model only exposes the
 * low levels, where a full seven-stop slider would be noise.
 */

import type { ThinkingLevel } from "@taco-ai/protocol";
import { THINKING_LEVELS } from "@taco-ai/protocol";
import { useT } from "../../i18n/useI18n.ts";
import { Slider } from "../ui/Slider.tsx";

interface ThinkingSliderProps {
    value: ThinkingLevel;
    onChange: (next: ThinkingLevel) => void;
    disabled?: boolean;
    /** Offered levels; defaults to the full THINKING_LEVELS range. */
    levels?: readonly ThinkingLevel[];
    /**
     * Accessible name of the slider. Defaults to the generic "thinking level"
     * label; a second slider on the same screen needs its own name.
     */
    ariaLabel?: string;
    /** Optional first stop restores the model’s default reasoning policy. */
    modelDefault?: { selected: boolean; onSelect: () => void };
}

export function ThinkingSlider(props: ThinkingSliderProps) {
    const { t } = useT();
    const levels = props.levels ?? THINKING_LEVELS;
    const offset = props.modelDefault ? 1 : 0;
    const labels = props.modelDefault ? [t("settings.thinkingModelDefault"), ...levels] : levels;
    const n = labels.length;
    const rawIdx = levels.indexOf(props.value);
    const currentIdx = props.modelDefault?.selected ? 0 : Math.max(0, rawIdx) + offset;
    const currentLabel = labels[currentIdx];

    function commit(idx: number) {
        const clamped = Math.max(0, Math.min(n - 1, idx));
        if (props.modelDefault && clamped === 0) {
            if (!props.modelDefault.selected) props.modelDefault.onSelect();
            return;
        }
        const next = levels[clamped - offset];
        if (next && (props.modelDefault?.selected || next !== props.value)) props.onChange(next);
    }

    const max = n - 1;
    // A single-level range has no span to slide over — guard the division.
    const markLeft = (i: number): string => (max > 0 ? `${(i / max) * 100}%` : "0%");

    return (
        <div className="thinking-slider">
            <div className="thinking-slider-labels">
                <span>{labels[0]}</span>
                <span>{labels[max]}</span>
            </div>
            <Slider
                value={currentIdx}
                min={0}
                max={max}
                step={1}
                variant="brand"
                ariaLabel={props.ariaLabel ?? t("modelMenu.thinkingLevel")}
                ariaValueText={currentLabel}
                disabled={props.disabled}
                onValueChange={commit}
                marks={labels.map((lvl, i) => (
                    <span
                        key={lvl}
                        className={`thinking-slider-tick${i === currentIdx ? " active" : ""}`}
                        style={{ left: markLeft(i) }}
                        aria-hidden="true"
                    />
                ))}
            />
            <div className="thinking-slider-current">{currentLabel}</div>
        </div>
    );
}
