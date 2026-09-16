/**
 * HighlightedCode — shiki-highlighted block with a plain-text fallback.
 *
 * Extracted from FilesPreviewPane so the file preview and the tool cards' raw
 * arguments share one highlighting path: the async load, the code/html pairing,
 * and the grammar-failure fallback are all things both need and neither should
 * reimplement.
 *
 * Emits shiki's dual-theme output (`--shiki-light` / `--shiki-dark`), which the
 * global `.shiki` rules in chatMarkdown.css already map to the active theme, so
 * switching themes needs no re-render.
 */

import { useEffect, useState } from "react";
import { codeToHtml } from "shiki";

export interface HighlightedCodeProps {
    code: string;
    /** Shiki language id. "text" skips highlighting entirely. */
    lang: string;
    /** Applied to the highlighted container and the fallback alike. */
    className?: string;
}

export function HighlightedCode({ code, lang, className }: HighlightedCodeProps) {
    // Pair html with the code it came from: switching inputs must not briefly
    // render the previous input's highlighted html.
    const [highlighted, setHighlighted] = useState<{ code: string; html: string } | null>(null);

    useEffect(() => {
        if (lang === "text") return;
        let cancelled = false;
        codeToHtml(code, {
            lang,
            themes: { light: "github-light", dark: "github-dark" },
            defaultColor: false,
        })
            .then((h) => {
                if (!cancelled) setHighlighted({ code, html: h });
            })
            .catch(() => {
                // Unknown grammar in the shiki bundle — plain text fallback.
            });
        return () => {
            cancelled = true;
        };
    }, [code, lang]);

    const html = highlighted?.code === code ? highlighted.html : null;
    if (lang === "text" || html === null) {
        return <pre className={className}>{code}</pre>;
    }
    // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki output is escaped token spans
    return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}
