/**
 * Renders a mermaid fenced block as an SVG diagram with Pele.
 *
 * Pele is pulled in with a dynamic import the first time a mermaid block
 * actually appears. The code-block surface is always dark (`--terminal-bg`,
 * fixed across light/dark themes), so its CSS variables are set on the wrapper.
 *
 * Streaming: the source arrives token-by-token and is mid-edit most of the
 * time, so rendering is debounced and any failure (incomplete or invalid
 * source) keeps the last good SVG, falling back to the code block when no
 * render has succeeded yet.
 */

import { type ReactNode, useEffect, useRef, useState } from "react";

type PeleModule = typeof import("pele");

let pelePromise: Promise<PeleModule> | null = null;

function loadPele(): Promise<PeleModule> {
    pelePromise ??= import("pele").catch((err) => {
        // Reset so the next diagram retries instead of reusing a poisoned
        // rejected promise forever; keep source fallback diagnosable.
        pelePromise = null;
        console.warn("[taco] pele failed to load; diagram view unavailable", err);
        throw err;
    });
    return pelePromise;
}

/** Debounce so streaming tokens don't trigger a re-render per keystroke. */
const RENDER_DEBOUNCE_MS = 250;

let renderSeq = 0;

interface MermaidDiagramProps {
    /** Raw mermaid source. */
    code: string;
    /** Rendered while loading and whenever rendering fails. */
    fallback: ReactNode;
}

export function MermaidDiagram({ code, fallback }: MermaidDiagramProps) {
    const [svg, setSvg] = useState<string | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        let cancelled = false;
        const idPrefix = `taco-mmd-${++renderSeq}`;
        const timer = setTimeout(() => {
            loadPele()
                .then(({ render }) =>
                    render(code, {
                        idPrefix,
                        links: false,
                        images: false,
                    }),
                )
                .then(({ svg }) => {
                    if (!cancelled) setSvg(svg);
                })
                .catch(() => {
                    // Incomplete (streaming) or invalid source: keep the last
                    // good render, or stay on the code fallback if none yet.
                    if (!cancelled) setSvg(null);
                });
        }, RENDER_DEBOUNCE_MS);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [code]);

    // Inject via ref rather than dangerouslySetInnerHTML (lint-forbidden).
    // Pele escapes diagram text and the render options disable untrusted links
    // and images before this SVG reaches the DOM.
    useEffect(() => {
        if (containerRef.current && svg !== null) {
            containerRef.current.innerHTML = svg;
        }
    }, [svg]);

    if (svg === null) return <>{fallback}</>;
    return <div className="md-mermaid" ref={containerRef} />;
}
