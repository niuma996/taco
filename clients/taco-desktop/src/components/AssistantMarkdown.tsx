import rehypeShikiFromHighlighter, { type RehypeShikiCoreOptions } from "@shikijs/rehype/core";
import { type ReactNode, useMemo, useSyncExternalStore } from "react";
import Markdown, { type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Highlighter } from "shiki";

import {
    ensureLanguages,
    fenceLanguages,
    getHighlighter,
    getHighlighterVersion,
    SHIKI_THEMES,
    subscribeHighlighter,
} from "../lib/shikiHighlighter";
import { CodeBlockWithCopy } from "./CodeBlockWithCopy";
import { ScrollableTable } from "./ScrollableTable";

type ShikiTransformer = NonNullable<RehypeShikiCoreOptions["transformers"]>[number];
type PluginList = NonNullable<Options["rehypePlugins"]>;
type HighlightCache = NonNullable<RehypeShikiCoreOptions["cache"]>;

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

interface HastParent {
    type: string;
    children?: HastParent[];
}

/**
 * Splice shiki's per-block `root` fragments into their parent. rehype-shiki
 * swaps a `<pre>` for a keyless root, so a block rendered plain first (grammar
 * still loading) and highlighted later changed element type in React's eyes —
 * the code block remounted, losing its toggle state and re-rendering any
 * mermaid diagram. Unwrapped, both renders are a `<pre>` at the same position.
 */
function unwrapShikiFragments() {
    const unwrap = (node: HastParent): void => {
        const kids = node.children;
        if (!kids) return;
        for (let i = 0; i < kids.length; i++) {
            const child = kids[i];
            if (child?.type === "root" && child.children) {
                kids.splice(i, 1, ...child.children);
                i += child.children.length - 1;
            } else if (child) {
                unwrap(child);
            }
        }
    };
    return (tree: HastParent) => unwrap(tree);
}

/**
 * Highlighted fragments by language + source, so a block is tokenized once
 * however often its message re-renders or remounts (switching back to a
 * session, expanding the render window). Oldest entries go first.
 */
class BoundedCache implements HighlightCache {
    private readonly map = new Map<string, ReturnType<HighlightCache["get"]>>();
    constructor(private readonly limit: number) {}
    get(key: string) {
        return this.map.get(key);
    }
    set(key: string, value: NonNullable<ReturnType<HighlightCache["get"]>>) {
        if (this.map.size >= this.limit) {
            const oldest = this.map.keys().next().value;
            if (oldest !== undefined) this.map.delete(oldest);
        }
        this.map.set(key, value);
        return this;
    }
}

// Module-level so every render passes the same references.
const REMARK_PLUGINS: NonNullable<Options["remarkPlugins"]> = [remarkGfm];
const NO_REHYPE_PLUGINS: PluginList = [];
const COMPONENTS = { pre: CodeBlockWithCopy, table: ScrollableTable };

let shikiPlugins: { highlighter: Highlighter; plugins: PluginList } | null = null;

/** Built once per highlighter; plain markdown until it is ready. */
function rehypePluginsFor(highlighter: Highlighter | null): PluginList {
    if (!highlighter) return NO_REHYPE_PLUGINS;
    if (shikiPlugins?.highlighter !== highlighter) {
        const options: RehypeShikiCoreOptions = {
            themes: SHIKI_THEMES,
            defaultColor: false,
            transformers: [captureLanguage],
            cache: new BoundedCache(500),
            // Rendering is synchronous now, so a throw would take the whole
            // message down; a failed block just stays plain.
            onError: (err) => console.warn("[taco] shiki highlight failed", err),
        };
        shikiPlugins = {
            highlighter,
            plugins: [[rehypeShikiFromHighlighter, highlighter, options], unwrapShikiFragments],
        };
    }
    return shikiPlugins.plugins;
}

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
 * Rendered synchronously so a message mounts at its final height: the async
 * variant mounted every message empty and filled them in one by one, which
 * made a freshly opened conversation flash and jump while stick-to-bottom
 * chased it. Highlighting comes from a preloaded highlighter
 * (`lib/shikiHighlighter`); a block whose grammar is still loading renders
 * plain and recolours in place once it arrives — same lines, same height.
 *
 * Overrides `components.pre` rather than `components.code` — inline code
 * never wraps in `<pre>`, so `pre` cleanly separates the two rendering paths.
 */
export function AssistantMarkdown({ text, className }: AssistantMarkdownProps) {
    // Re-render when the highlighter becomes ready or a grammar finishes loading.
    const highlighterVersion = useSyncExternalStore(subscribeHighlighter, getHighlighterVersion);
    const highlighter = getHighlighter();
    const langs = useMemo(() => fenceLanguages(text), [text]);
    // A no-op once loaded; the version bump re-runs this render path.
    ensureLanguages(langs);

    // Synchronous react-markdown re-parses on every render; parse only when
    // the text or the available grammars change.
    // biome-ignore lint/correctness/useExhaustiveDependencies: highlighterVersion is the trigger — a newly loaded grammar must re-highlight the same text.
    const body: ReactNode = useMemo(
        () => (
            <Markdown
                remarkPlugins={REMARK_PLUGINS}
                rehypePlugins={rehypePluginsFor(highlighter)}
                components={COMPONENTS}
            >
                {text}
            </Markdown>
        ),
        [text, highlighter, highlighterVersion],
    );

    return <div className={className ?? "md-assistant"}>{body}</div>;
}
