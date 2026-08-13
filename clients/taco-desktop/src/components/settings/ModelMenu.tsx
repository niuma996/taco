/**
 * ModelMenu — custom popover listing selectable models with check-mark state
 * and optional thinking-level slider at the bottom (chat-input scenario).
 *
 * Outside-click to close: a document capture-phase listener checks the pointerdown
 * target — only close when the target is outside the anchor subtree.
 */

import type { ThinkingLevel } from "@taco-ai/protocol";
import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n/useI18n.ts";
import type { ModelOption, ModelSelection } from "./ModelPicker";
import { ThinkingSlider } from "./ThinkingSlider";

interface ModelMenuProps {
    /** Currently selected model; `undefined` = none (shows "Select a model" placeholder). */
    value: ModelSelection | undefined;
    options: ModelOption[];
    onModelChange: (next: ModelSelection) => void;
    disabled?: boolean;
    pendingNote?: boolean;
    /** Fired when the user is about to open the dropdown. Callers use this to trigger a model-list refetch. */
    onOpen?: () => void;
    /** When provided, the popover also renders a thinking-level slider at the bottom (chat-input scenario). */
    thinkingValue?: ThinkingLevel;
    onThinkingChange?: (next: ThinkingLevel) => void;
    /** Popover placement: up (default; chat input) or down (settings drawer — its top
     * space is too tight for an upward expand, and the `.drawer` overflow would clip it). */
    placement?: "up" | "down";
}

export function ModelMenu(props: ModelMenuProps) {
    const [open, setOpen] = useState(false);
    const anchorRef = useRef<HTMLDivElement | null>(null);
    const { t } = useT();

    useEffect(() => {
        if (!open) return;
        // Capture phase: when clicking inside the popup (a descendant of the anchor),
        // the target is still within the anchor subtree, so anchorRef.contains(target)
        // is true and we skip the close branch — onClick fires normally.
        function onPointerDown(e: PointerEvent) {
            if (anchorRef.current?.contains(e.target as Node)) return;
            setOpen(false);
        }
        function onKey(e: KeyboardEvent) {
            if (e.key === "Escape") setOpen(false);
        }
        document.addEventListener("pointerdown", onPointerDown, true);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("pointerdown", onPointerDown, true);
            document.removeEventListener("keydown", onKey);
        };
    }, [open]);

    function toggle() {
        if (!open) props.onOpen?.();
        setOpen((v) => !v);
    }

    const placement = props.placement ?? "up";
    const current = props.value
        ? props.options.find(
              (o) => o.provider === props.value?.provider && o.id === props.value?.id,
          )
        : undefined;
    const hasSelection = Boolean(props.value);
    const label = current?.name ?? current?.id ?? props.value?.id ?? t("modelMenu.selectModel");

    return (
        <div
            className={`model-menu${placement === "down" ? " model-menu--down" : ""}`}
            ref={anchorRef}
        >
            <button
                type="button"
                className="prompt-button model-trigger"
                aria-haspopup="menu"
                aria-expanded={open}
                disabled={props.disabled}
                onClick={toggle}
                title={props.pendingNote ? t("modelMenu.takesEffectNextTurn") : undefined}
            >
                <span className="model-trigger-label">{label}</span>
                {hasSelection && props.value && (
                    <span className="model-trigger-provider">({props.value.provider})</span>
                )}
            </button>
            {open && (
                <div className="model-menu-popup" role="menu">
                    <div className="model-menu-section">
                        <div className="model-menu-header">{t("modelMenu.modelSection")}</div>
                        {props.options.map((opt) => {
                            const selected =
                                props.value !== undefined &&
                                opt.provider === props.value.provider &&
                                opt.id === props.value.id;
                            return (
                                <button
                                    key={`${opt.provider}|${opt.id}`}
                                    type="button"
                                    role="menuitemradio"
                                    aria-checked={selected}
                                    className={`model-menu-item${selected ? " selected" : ""}`}
                                    onClick={() => {
                                        props.onModelChange({
                                            provider: opt.provider,
                                            id: opt.id,
                                        });
                                        setOpen(false);
                                    }}
                                >
                                    <span className="model-menu-item-name">
                                        {opt.name ?? opt.id}
                                    </span>
                                    <span className="model-menu-item-provider">{opt.provider}</span>
                                </button>
                            );
                        })}
                    </div>
                    {props.thinkingValue !== undefined && props.onThinkingChange && (
                        <>
                            <div className="model-menu-divider" />
                            <div className="model-menu-section">
                                <div className="model-menu-header">
                                    {t("modelMenu.thinkingSection")}
                                </div>
                                <ThinkingSlider
                                    value={props.thinkingValue}
                                    onChange={props.onThinkingChange}
                                    disabled={props.disabled}
                                />
                            </div>
                        </>
                    )}
                </div>
            )}
        </div>
    );
}
