import rehypeShiki, { type RehypeShikiOptions } from "@shikijs/rehype";
import { MarkdownHooks as ReactMarkdown } from "react-markdown";
import remarkGfm from "remark-gfm";

import { CodeBlockWithCopy } from "./CodeBlockWithCopy";
import { ScrollableTable } from "./ScrollableTable";

type ShikiTransformer = NonNullable<RehypeShikiOptions["transformers"]>[number];

/**
 * Tag shiki's generated `<pre>` with the resolved language so the `pre`
 * override can render it in the block header. This must live in a shiki
 * transformer: `@shikijs/rehype` replaces the original `<pre>` node outright,
 * so a rehype plugin running earlier writes onto a node that never reaches
 * the output. hast's camelCase `dataLanguage` surfaces on the React side as
 * the `data-language` prop. Blocks without a `language-*` class are skipped
 * by rehype-shiki entirely, so this hook never fires for them.
 */
const captureLanguage: ShikiTransformer = {
    name: "taco:capture-language",
    pre(node) {
        node.properties ??= {};
        node.properties.dataLanguage = String(this.options.lang);
    },
};

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
                            themes: {
                                light: "github-light",
                                dark: "github-dark",
                            },
                            defaultColor: false,
                            transformers: [captureLanguage],
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
