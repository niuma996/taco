/**
 * CopyButton — clipboard write with idle / copied / failed state.
 *
 * Single shared copy button: code-block headers (CodeBlockWithCopy) and the
 * per-message meta row (MessageMeta) both need the same `navigator.clipboard`
 * + `execCommand` fallback and the same icon-swap-on-success pattern, so the
 * state machine and the writeToClipboard plumbing live here once.
 *
 * `labels` is required so the caller owns its own copy — the button stays
 * free of i18n coupling (this lives under `ui/`, which has no locale).
 */

import { Check, Copy, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export type CopyState = "idle" | "copied" | "failed";

export interface CopyButtonLabels {
    /** aria-label + initial title. */
    idle: string;
    /** title shown briefly after a successful copy. */
    copied: string;
    /** title shown briefly after a failed copy (navigator.clipboard unavailable
     *  and the execCommand fallback also returned false). */
    failed: string;
}

export interface CopyButtonProps {
    value: string;
    /** Applied to the <button>; consumers pick their own icon-button shape. */
    className?: string;
    labels: CopyButtonLabels;
    /** How long the copied/failed state lingers before reverting. */
    resetMs?: number;
}

/**
 * Write `value` to the clipboard, preferring `navigator.clipboard` and falling
 * back to a hidden-textarea + `execCommand("copy")` for environments where
 * the clipboard API is unavailable (older WebViews, Tauri without clipboard
 * permission).
 */
async function writeToClipboard(value: string): Promise<boolean> {
    try {
        if (
            typeof navigator !== "undefined" &&
            navigator.clipboard &&
            typeof navigator.clipboard.writeText === "function"
        ) {
            await navigator.clipboard.writeText(value);
            return true;
        }
    } catch {
        // fall through to the legacy path
    }
    try {
        const ta = document.createElement("textarea");
        ta.value = value;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        ta.style.pointerEvents = "none";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        return ok;
    } catch {
        return false;
    }
}

export function CopyButton({ value, className, labels, resetMs = 1500 }: CopyButtonProps) {
    const [state, setState] = useState<CopyState>("idle");
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(
        () => () => {
            if (timerRef.current !== null) clearTimeout(timerRef.current);
        },
        [],
    );

    const handleClick = async () => {
        const ok = await writeToClipboard(value);
        setState(ok ? "copied" : "failed");
        if (timerRef.current !== null) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
            setState("idle");
            timerRef.current = null;
        }, resetMs);
    };

    const Icon = state === "copied" ? Check : state === "failed" ? X : Copy;
    const title =
        state === "copied" ? labels.copied : state === "failed" ? labels.failed : labels.idle;
    return (
        <button
            type="button"
            className={className}
            onClick={handleClick}
            aria-label={labels.idle}
            title={title}
            data-state={state}
        >
            <Icon size={13} aria-hidden="true" />
        </button>
    );
}
