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
