/**
 * Renders a mermaid fenced block as an SVG diagram.
 *
 * mermaid + d3 are far too heavy for the initial chat chunk, so the library is
 * pulled in with a dynamic import the first time a mermaid block actually
 * appears. The code-block surface is always dark (`--terminal-bg`, fixed
 * across light/dark themes), so mermaid is initialized with its `dark` theme.
 *
 * Streaming: the source arrives token-by-token and is mid-edit most of the
 * time, so rendering is debounced and any failure (incomplete or invalid
 * source) keeps the last good SVG, falling back to the code block when no
 * render has succeeded yet.
 */

import { type ReactNode, useEffect, useRef, useState } from "react";

type MermaidModule = typeof import("mermaid");

let mermaidPromise: Promise<MermaidModule> | null = null;

function loadMermaid(): Promise<MermaidModule> {
    mermaidPromise ??= import("mermaid")
        .then((m) => {
            m.default.initialize({
                startOnLoad: false,
                theme: "dark",
                securityLevel: "strict",
            });
            return m;
        })
        .catch((err) => {
            // Reset so the next mermaid block retries instead of reusing a
            // poisoned rejected promise forever; warn so a bundling/install
            // problem is diagnosable rather than silently stuck on source view.
            mermaidPromise = null;
            console.warn("[taco] mermaid failed to load; diagram view unavailable", err);
            throw err;
        });
    return mermaidPromise;
}

/** Debounce so streaming tokens don't trigger a re-render per keystroke. */
const RENDER_DEBOUNCE_MS = 250;

let renderSeq = 0;

/** Remove the temporary node mermaid may leave in the document on some failure paths. */
function dropTempNode(id: string) {
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
}

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
        const id = `mmd-${++renderSeq}`;
        const timer = setTimeout(() => {
            loadMermaid()
                .then((m) => m.default.render(id, code))
                .then(({ svg }) => {
                    if (!cancelled) setSvg(svg);
                })
                .catch(() => {
                    // Incomplete (streaming) or invalid source: keep the last
                    // good render, or stay on the code fallback if none yet.
                    if (!cancelled) setSvg(null);
                })
                .finally(() => dropTempNode(id));
        }, RENDER_DEBOUNCE_MS);
        return () => {
            cancelled = true;
            clearTimeout(timer);
            dropTempNode(id);
        };
    }, [code]);

    // Inject via ref rather than dangerouslySetInnerHTML (lint-forbidden).
    // mermaid `strict` securityLevel sanitizes the SVG before it reaches us.
    useEffect(() => {
        if (containerRef.current && svg !== null) {
            containerRef.current.innerHTML = svg;
        }
    }, [svg]);

    if (svg === null) return <>{fallback}</>;
    return <div className="md-mermaid" ref={containerRef} />;
}
