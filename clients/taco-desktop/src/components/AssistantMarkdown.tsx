import rehypeShiki from "@shikijs/rehype";
import { MarkdownHooks as ReactMarkdown } from "react-markdown";
import remarkGfm from "remark-gfm";

import { CodeBlockWithCopy } from "./CodeBlockWithCopy";
import { ScrollableTable } from "./ScrollableTable";

interface AssistantMarkdownProps {
    /** The raw markdown text to render. May be partial during streaming. */
    text: string;
    /** Optional className for the outer wrapper div. */
    className?: string;
}

/**
 * Renders an assistant message body as GFM markdown with shiki-powered fenced
 * code highlighting and a per-block copy button.
 *
 * Uses `MarkdownHooks` (async variant) because rehype-shiki is async.
 * Overrides `components.pre` rather than `components.code` — inline code
 * never wraps in `<pre>`, so `pre` cleanly separates the two rendering paths.
 */
export function AssistantMarkdown({ text, className }: AssistantMarkdownProps) {
    return (
        <div className={className ?? "md-assistant"}>
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[
                    [
                        rehypeShiki,
                        {
                            themes: { light: "github-light", dark: "github-dark" },
                            defaultColor: false,
                        },
                    ],
                ]}
                components={{ pre: CodeBlockWithCopy, table: ScrollableTable }}
                fallback={null}
            >
                {text}
            </ReactMarkdown>
        </div>
    );
}
