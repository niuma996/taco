import { useEffect, useRef, useState } from "react";

import { useT } from "../i18n/useI18n";

interface CopyButtonProps {
    /** The text to write to the clipboard when the button is clicked. */
    value: string;
    /** Optional className appended to the default `.md-copy-btn` class. */
    className?: string;
}

type CopyState = "idle" | "copied" | "failed";

/**
 * Small button that writes `value` to the clipboard and briefly flashes
 * "Copied" / "Failed" feedback. Uses `navigator.clipboard` when available
 * and falls back to a hidden-textarea + `execCommand("copy")` trick.
 */
export function CopyButton({ value, className }: CopyButtonProps) {
    const [state, setState] = useState<CopyState>("idle");
    const { t } = useT();
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(
        () => () => {
            if (timerRef.current !== null) clearTimeout(timerRef.current);
        },
        [],
    );

    const handleClick = async () => {
        let ok = false;
        try {
            if (
                typeof navigator !== "undefined" &&
                navigator.clipboard &&
                typeof navigator.clipboard.writeText === "function"
            ) {
                await navigator.clipboard.writeText(value);
                ok = true;
            }
        } catch {
            ok = false;
        }

        if (!ok) {
            // Fallback: hidden textarea + execCommand. Works in older WebViews
            // and inside Tauri when clipboard permission isn't granted.
            try {
                const ta = document.createElement("textarea");
                ta.value = value;
                ta.setAttribute("readonly", "");
                ta.style.position = "fixed";
                ta.style.opacity = "0";
                ta.style.pointerEvents = "none";
                document.body.appendChild(ta);
                ta.select();
                ok = document.execCommand("copy");
                document.body.removeChild(ta);
            } catch {
                ok = false;
            }
        }

        setState(ok ? "copied" : "failed");
        if (timerRef.current !== null) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
            setState("idle");
            timerRef.current = null;
        }, 1500);
    };

    const label =
        state === "copied"
            ? t("copy.copied")
            : state === "failed"
              ? t("copy.failed")
              : t("copy.label");
    const cls = `md-copy-btn${className ? ` ${className}` : ""}`;

    return (
        <button
            type="button"
            className={cls}
            onClick={handleClick}
            aria-label={t("copy.codeCopied")}
            data-state={state}
        >
            {label}
        </button>
    );
}
