/**
 * react-markdown `components.pre` override — wraps fenced code blocks with a
 * copy-button header above the shiki tokenized `<pre>`.
 *
 * Overrides `pre` (not `code`): react-markdown v10 removed the `inline` prop
 * older overrides used to branch on, and rehype-shiki strips the language
 * className from the inner `<code>`, leaving no reliable inline detection on
 * `code`. Fenced blocks fire `pre`; inline code never wraps in `<pre>`.
 */

import { Children, type ComponentProps, isValidElement, type ReactNode } from "react";

import { CopyButton } from "./CopyButton";

type PreProps = ComponentProps<"pre"> & {
    /** Destructured so it is not spread onto the DOM (React 19 warns otherwise). */
    node?: unknown;
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
    const { className, children, ref: _ref, node: _node, ...rest } = props;
    const codeText = collectText(children);

    return (
        <div className="md-code-block">
            <div className="md-code-header">
                <span className="md-code-lang">code</span>
                <CopyButton value={codeText} />
            </div>
            <pre className={className} {...rest}>
                {children}
            </pre>
        </div>
    );
}
