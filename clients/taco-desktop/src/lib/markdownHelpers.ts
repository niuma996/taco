import type { ReactNode } from "react";

/**
 * Extract the language tag from a react-markdown `code` component's className.
 *
 * react-markdown emits className like `"language-python"` for fenced blocks.
 * shiki's rehype plugin may also prepend its own classes (e.g. `"shiki language-go"`).
 * Inline code passes `className={undefined}` from react-markdown.
 *
 * @returns the language tag, or `""` if none is present.
 */
export function extractCodeLanguage(className: string | undefined): string {
    if (!className) return "";
    const match = /language-(\S+)/.exec(className);
    return match ? match[1] : "";
}

/**
 * Coerce react-markdown's `code` component children to a plain string for the copy button.
 *
 * react-markdown passes:
 * - a single string for inline code,
 * - a single string for short fenced blocks,
 * - an array of strings (one per line) for multi-line fenced blocks,
 * - occasionally `undefined` for empty code nodes.
 *
 * @returns the concatenated string content.
 */
export function codeChildrenToString(children: ReactNode): string {
    if (children === undefined || children === null) return "";
    if (typeof children === "string") return children;
    if (typeof children === "number") return String(children);
    if (Array.isArray(children)) {
        return children.map((c) => codeChildrenToString(c)).join("");
    }
    if (typeof children === "object" && "props" in children) {
        const props = (children as { props: { children?: ReactNode } }).props;
        return codeChildrenToString(props.children);
    }
    return "";
}
