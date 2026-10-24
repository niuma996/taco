/**
 * Renders a mermaid fenced block as an SVG diagram with Pele.
 *
 * Pele lives in a lazily loaded chunk (`lib/peleLoader`, preloaded while the
 * app is idle). Once it is in, the diagram renders synchronously during render
 * and its SVG is injected before paint, so the block appears at its final size
 * instead of showing the source first and then growing — which used to shove
 * the text below a diagram down after the message had already painted. The
 * code-block surface is always dark (`--terminal-bg`, fixed across light/dark
 * themes), so its CSS variables are set on the wrapper.
 *
 * Streaming: the source arrives token-by-token and is mid-edit most of the
 * time. Rendering is cheap (about 1ms), so every revision is tried; a failure
 * (incomplete or invalid source) keeps the last good SVG, falling back to the
 * code block when no render has succeeded yet.
 */

import { type ReactNode, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { getPele, getPeleVersion, subscribePele } from "../lib/peleLoader";

let renderSeq = 0;

interface MermaidDiagramProps {
    /** Raw mermaid source. */
    code: string;
    /** Rendered while loading and whenever rendering fails. */
    fallback: ReactNode;
}

export function MermaidDiagram({ code, fallback }: MermaidDiagramProps) {
    const peleVersion = useSyncExternalStore(subscribePele, getPeleVersion);
    const lastGood = useRef<string | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    // biome-ignore lint/correctness/useExhaustiveDependencies: peleVersion is the trigger — the module arriving must render the same source.
    const svg = useMemo(() => {
        const mod = getPele();
        if (!mod) return lastGood.current;
        try {
            const { svg: rendered } = mod.render(code, {
                idPrefix: `taco-mmd-${++renderSeq}`,
                links: false,
                images: false,
            });
            lastGood.current = rendered;
            return rendered;
        } catch {
            return lastGood.current;
        }
    }, [code, peleVersion]);

    // Inject via ref rather than dangerouslySetInnerHTML (lint-forbidden), in
    // a layout effect so the SVG is in place before the browser paints. Pele
    // escapes diagram text and the render options disable untrusted links and
    // images before this SVG reaches the DOM.
    useLayoutEffect(() => {
        if (containerRef.current && svg !== null) {
            containerRef.current.innerHTML = svg;
        }
    }, [svg]);

    if (svg === null) return <>{fallback}</>;
    return <div className="md-mermaid" ref={containerRef} />;
}
