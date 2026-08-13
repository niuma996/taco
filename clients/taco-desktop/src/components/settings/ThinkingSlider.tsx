/**
 * ThinkingSlider — discrete horizontal slider over THINKING_LEVELS.
 *
 * Renders the shared ui/Slider with one mark per level and a center-aligned
 * current-level label. The slider value is the level index; aria-valuetext
 * carries the level name. Left end = off, right end = highest.
 */

import type { ThinkingLevel } from "@taco-ai/protocol";
import { useT } from "../../i18n/useI18n.ts";
import { THINKING_LEVELS } from "../../lib/globalConfig";
import { Slider } from "../ui/Slider.tsx";

interface ThinkingSliderProps {
    value: ThinkingLevel;
    onChange: (next: ThinkingLevel) => void;
    disabled?: boolean;
}

export function ThinkingSlider(props: ThinkingSliderProps) {
    const { t } = useT();
    const levels = THINKING_LEVELS;
    const n = levels.length;
    // Fallback: if props.value isn't in THINKING_LEVELS (the backend returned an
    // unknown level), indexOf returns -1 and the index math goes off. Clamp to 0.
    const rawIdx = levels.indexOf(props.value);
    const currentIdx = rawIdx < 0 ? 0 : rawIdx;

    function commit(idx: number) {
        const clamped = Math.max(0, Math.min(n - 1, idx));
        const next = levels[clamped];
        if (next && next !== props.value) props.onChange(next);
    }

    const max = n - 1;

    return (
        <div className="thinking-slider">
            <div className="thinking-slider-labels">
                <span>off</span>
                <span>{levels[max]}</span>
            </div>
            <Slider
                value={currentIdx}
                min={0}
                max={max}
                step={1}
                variant="brand"
                ariaLabel={t("modelMenu.thinkingLevel")}
                ariaValueText={props.value}
                disabled={props.disabled}
                onValueChange={commit}
                marks={levels.map((lvl, i) => (
                    <span
                        key={lvl}
                        className={`thinking-slider-tick${i === currentIdx ? " active" : ""}`}
                        style={{ left: `${(i / max) * 100}%` }}
                        aria-hidden="true"
                    />
                ))}
            />
            <div className="thinking-slider-current">{props.value}</div>
        </div>
    );
}
