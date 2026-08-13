/**
 * Slider — shared horizontal slider backed by @radix-ui/react-slider, which
 * supplies drag / click-to-jump / Arrow-Home-End handling. `onValueChange`
 * fires live while dragging, `onValueCommit` on release. `marks` overlays
 * decorations on the track: position each at `left: <percent>%` and it lands
 * on the thumb center for that percent (see .ui-slider-marks in ui.css).
 * `variant` switches fill/thumb between the neutral accent and brand orange.
 */
import * as SliderPrimitive from "@radix-ui/react-slider";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

type SliderPrimitiveProps = Omit<
    ComponentPropsWithoutRef<typeof SliderPrimitive.Root>,
    "value" | "onValueChange" | "onValueCommit" | "min" | "max" | "step" | "disabled"
>;

export interface SliderProps extends SliderPrimitiveProps {
    value: number;
    min: number;
    max: number;
    step?: number;
    onValueChange?: (value: number) => void;
    onValueCommit?: (value: number) => void;
    disabled?: boolean;
    ariaLabel?: string;
    /** Screen-reader text for the current value (e.g. the level name). */
    ariaValueText?: string;
    variant?: "default" | "brand";
    /** Decorations overlayed on the track, each positioned at `left: <percent>%`. */
    marks?: ReactNode;
}

export function Slider(props: SliderProps) {
    const {
        value,
        min,
        max,
        step,
        onValueChange,
        onValueCommit,
        disabled,
        ariaLabel,
        ariaValueText,
        variant,
        marks,
        className,
        ...rest
    } = props;

    const rootClass = `ui-slider${variant === "brand" ? " ui-slider--brand" : ""}`;

    return (
        <SliderPrimitive.Root
            {...rest}
            className={className ? `${rootClass} ${className}` : rootClass}
            value={[value]}
            min={min}
            max={max}
            step={step}
            disabled={disabled}
            onValueChange={(v) => onValueChange?.(v[0])}
            onValueCommit={(v) => onValueCommit?.(v[0])}
        >
            <SliderPrimitive.Track className="ui-slider-track">
                <SliderPrimitive.Range className="ui-slider-range" />
            </SliderPrimitive.Track>
            {marks !== undefined && (
                <div className="ui-slider-marks" aria-hidden="true">
                    {marks}
                </div>
            )}
            <SliderPrimitive.Thumb
                className="ui-slider-thumb"
                aria-label={ariaLabel}
                aria-valuetext={ariaValueText}
            />
        </SliderPrimitive.Root>
    );
}
