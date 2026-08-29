import type { ReactNode } from "react";

/**
 * Strip a leading YAML frontmatter block from markdown source.
 *
 * `skills.content` returns the raw SKILL.md, frontmatter included. Rendering it
 * as markdown is actively wrong: a `---` line directly under text is setext
 * syntax, so `name:`/`description:` render as one big heading — and those two
 * fields are already shown above the body in the detail view. Stripping the
 * block removes the duplicate instead of restyling it.
 *
 * Only a block at the very start counts (optional leading blank lines allowed,
 * per how YAML tooling treats these files). A `---` appearing later in the body
 * is a legitimate horizontal rule and is left alone. Unterminated frontmatter
 * (no closing fence) is returned unchanged rather than swallowing the file.
 */
export function stripFrontmatter(markdown: string): string {
    const opening = /^\s*---[ \t]*\r?\n/.exec(markdown);
    if (!opening) return markdown;
    const rest = markdown.slice(opening[0].length);
    // Closing fence: a line that is exactly `---` (or `...`, which YAML also
    // accepts as an end-of-document marker). Matched against `rest` directly so
    // the index stays valid for CRLF input.
    const closing = /^(?:---|\.\.\.)[ \t]*\r?$/m.exec(rest);
    if (!closing) return markdown;
    const afterFence = rest.indexOf("\n", closing.index + closing[0].length);
    if (afterFence === -1) return "";
    return rest.slice(afterFence + 1).replace(/^\s*\r?\n/, "");
}

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
