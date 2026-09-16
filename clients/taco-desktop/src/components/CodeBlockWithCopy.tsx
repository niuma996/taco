/**
 * react-markdown `components.pre` override — wraps fenced code blocks with a
 * copy-button header above the shiki tokenized `<pre>`.
 *
 * Overrides `pre` (not `code`): react-markdown v10 removed the `inline` prop
 * older overrides used to branch on, and rehype-shiki swaps the whole `<pre>`
 * for a fragment whose className is `shiki …` (no `language-xxx`), leaving no
 * reliable inline detection on `code`. Fenced blocks fire `pre`; inline code
 * never wraps in `<pre>`.
 *
 * Language tag comes from the shiki `captureLanguage` transformer in
 * `AssistantMarkdown`, which tags shiki's own `<pre>` output — a rehype
 * plugin running before shiki would write onto the node shiki discards.
 * hast's `dataLanguage` property arrives here as the `data-language` prop.
 */

import { Code, Workflow } from "lucide-react";
import { Children, type ComponentProps, isValidElement, type ReactNode, useState } from "react";
import { MermaidDiagram } from "./MermaidDiagram";
import { CopyButton } from "./ui/CopyButton.tsx";

type PreProps = ComponentProps<"pre"> & {
    /** Destructured so it is not spread onto the DOM (React 19 warns otherwise). */
    node?: unknown;
    /** Set by the shiki `captureLanguage` transformer (e.g. "python"). */
    "data-language"?: string;
};

/**
 * Recursively collect text from React children that arrive as a tree of
 * token spans produced by shiki. Returns the concatenated plain string.
 */
function collectText(children: ReactNode): string {
    let out = "";
    Children.forEach(children, (child) => {
        if (typeof child === "string" || typeof child === "number") {
            out += String(child);
        } else if (isValidElement(child)) {
            out += collectText((child.props as { children?: ReactNode }).children);
        }
    });
    return out;
}

export function CodeBlockWithCopy(props: PreProps) {
    const {
        className,
        children,
        ref: _ref,
        node: _node,
        "data-language": language,
        ...rest
    } = props;
    const codeText = collectText(children);
    const label = language && language.length > 0 ? language : "code";
    const isMermaid = label.toLowerCase() === "mermaid";
    // Mermaid blocks default to the rendered diagram; the header toggle flips to source.
    const [showCode, setShowCode] = useState(false);

    const preElement = (
        <pre className={className} {...rest}>
            {children}
        </pre>
    );

    return (
        <div className="md-code-block">
            <div className="md-code-header">
                <span className="md-code-lang">{label}</span>
                <div className="md-code-actions">
                    {isMermaid && (
                        <button
                            type="button"
                            className="md-copy-btn"
                            onClick={() => setShowCode((v) => !v)}
                            aria-label={showCode ? "View diagram" : "View code"}
                            title={showCode ? "View diagram" : "View code"}
                        >
                            {showCode ? (
                                <Workflow size={13} aria-hidden="true" />
                            ) : (
                                <Code size={13} aria-hidden="true" />
                            )}
                        </button>
                    )}
                    <CopyButton
                        value={codeText}
                        className="md-copy-btn"
                        labels={{ idle: "Copy code", copied: "Copied", failed: "Copy failed" }}
                    />
                </div>
            </div>
            {isMermaid && !showCode ? (
                <MermaidDiagram code={codeText} fallback={preElement} />
            ) : (
                preElement
            )}
        </div>
    );
}
