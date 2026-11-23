import { Check } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";

export interface OptionCardItem<T extends string> {
    value: T;
    label: string;
    icon: ReactNode;
    description?: string;
}

export interface OptionCardGroupProps<T extends string> {
    label: string;
    value: T;
    items: readonly OptionCardItem<T>[];
    onValueChange: (value: T) => void;
    disabled?: boolean;
}

/** Controlled single-choice cards with roving focus and arrow-key selection. */
export function OptionCardGroup<T extends string>({
    label,
    value,
    items,
    onValueChange,
    disabled,
}: OptionCardGroupProps<T>) {
    if (items.length === 0) return null;

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (disabled || event.altKey || event.ctrlKey || event.metaKey) return;
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const cards = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=radio]"),
        );
        const focused = cards.indexOf(
            event.currentTarget.ownerDocument.activeElement as HTMLButtonElement,
        );
        const current =
            focused >= 0
                ? focused
                : Math.max(
                      0,
                      items.findIndex((item) => item.value === value),
                  );
        const next =
            event.key === "Home"
                ? 0
                : event.key === "End"
                  ? items.length - 1
                  : (current + (event.key === "ArrowRight" ? 1 : -1) + items.length) % items.length;
        const item = items[next];
        if (item) {
            cards[next]?.focus();
            onValueChange(item.value);
        }
    };

    return (
        <div
            className="ui-option-card-group"
            role="radiogroup"
            aria-label={label}
            onKeyDown={onKeyDown}
        >
            {items.map((item) => {
                const selected = item.value === value;
                return (
                    // biome-ignore lint/a11y/useSemanticElements: card radios need a composite layout; remove if this primitive adopts native input+label markup
                    <button
                        key={item.value}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        tabIndex={selected ? 0 : -1}
                        disabled={disabled}
                        className="ui-option-card"
                        onClick={() => onValueChange(item.value)}
                    >
                        <span className="ui-option-card__icon" aria-hidden="true">
                            {item.icon}
                        </span>
                        <span className="ui-option-card__text">
                            <span className="ui-option-card__label">{item.label}</span>
                            {item.description && (
                                <span className="ui-option-card__description">
                                    {item.description}
                                </span>
                            )}
                        </span>
                        <span className="ui-option-card__check" aria-hidden="true">
                            {selected && <Check size={14} />}
                        </span>
                    </button>
                );
            })}
        </div>
    );
}
