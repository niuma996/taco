/**
 * ModelMenu — custom popover listing selectable models grouped by provider,
 * with a search filter at the top and an optional thinking-level slider at
 * the bottom (chat-input scenario).
 *
 * Outside-click to close: a document capture-phase listener checks the pointerdown
 * target — only close when the target is outside the anchor subtree.
 */

import type { ThinkingLevel } from "@taco-ai/protocol";
import { Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n/useI18n.ts";
import { TextInput } from "../ui/TextInput.tsx";
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
    /** Popover placement: up (default; chat input) or down (settings pane — its top
     * space is too tight for an upward expand, and the pane overflow would clip it). */
    placement?: "up" | "down";
    /** Chat-input variant: flat borderless pill sized to its content. */
    compact?: boolean;
}

export function ModelMenu(props: ModelMenuProps) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
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

    // Clear the filter whenever the popup closes so the next open starts clean.
    useEffect(() => {
        if (!open) setQuery("");
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

    // Search matches id, display name, and provider id (case-insensitive).
    const q = query.trim().toLowerCase();
    const filtered =
        q === ""
            ? props.options
            : props.options.filter(
                  (o) =>
                      o.id.toLowerCase().includes(q) ||
                      (o.name ?? "").toLowerCase().includes(q) ||
                      o.provider.toLowerCase().includes(q),
              );
    // Group by provider, preserving option order within each group.
    const groups = new Map<string, ModelOption[]>();
    for (const opt of filtered) {
        const list = groups.get(opt.provider);
        if (list) list.push(opt);
        else groups.set(opt.provider, [opt]);
    }

    return (
        <div
            className={`model-menu${placement === "down" ? " model-menu--down" : ""}`}
            ref={anchorRef}
        >
            <button
                type="button"
                className={`prompt-button model-trigger${props.compact ? " model-trigger--compact" : ""}`}
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
                <div className="ui-menu model-menu-popup" role="menu">
                    <div className="model-menu-search">
                        <TextInput
                            type="text"
                            value={query}
                            placeholder={t("modelMenu.search")}
                            autoFocus
                            onChange={(e) => setQuery(e.target.value)}
                        />
                    </div>
                    <div className="model-menu-section">
                        {groups.size === 0 && (
                            <div className="model-menu-empty">{t("modelMenu.noMatch")}</div>
                        )}
                        {[...groups.entries()].map(([provider, opts]) => (
                            <div key={provider} className="model-menu-group">
                                <div className="model-menu-group-header">{provider}</div>
                                {opts.map((opt) => {
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
                                            className="ui-menu-item"
                                            onClick={() => {
                                                props.onModelChange({
                                                    provider: opt.provider,
                                                    id: opt.id,
                                                });
                                                setOpen(false);
                                            }}
                                        >
                                            <span className="ui-menu-label">
                                                {opt.name ?? opt.id}
                                            </span>
                                            {selected && <Check size={14} aria-hidden="true" />}
                                        </button>
                                    );
                                })}
                            </div>
                        ))}
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
