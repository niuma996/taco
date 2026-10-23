/**
 * Shared shiki highlighter for chat markdown, usable synchronously once ready.
 *
 * `@shikijs/rehype`'s default export is async and builds its singleton with
 * every bundled grammar (~350, seconds to load), so each message mounted empty
 * and filled in later — the conversation jumped while stick-to-bottom chased
 * it. This highlighter preloads the common grammars and loads others the first
 * time a fence uses them, so markdown renders synchronously: a code block stays
 * plain text until its grammar is in, then recolours at the same height.
 *
 * Readiness and grammar loads are exposed as a version counter for
 * `useSyncExternalStore`, so mounted markdown re-renders to pick them up.
 */

import { type BundledLanguage, bundledLanguages, createHighlighter, type Highlighter } from "shiki";

export const SHIKI_THEMES = { light: "github-light", dark: "github-dark" } as const;

/** Loaded up front; everything else in `bundledLanguages` loads on first use. */
const PRELOADED_LANGS: BundledLanguage[] = [
    "typescript",
    "tsx",
    "javascript",
    "jsx",
    "json",
    "jsonc",
    "shellscript",
    "python",
    "diff",
    "markdown",
    "yaml",
    "toml",
    "rust",
    "go",
    "html",
    "css",
    "sql",
];

let highlighter: Highlighter | null = null;
let version = 0;
const listeners = new Set<() => void>();
/** Grammars already asked for, so concurrent renders don't re-request one. */
const requested = new Set<string>();

let loading = false;

function notify(): void {
    version++;
    for (const listener of listeners) listener();
}

/** Starts on first subscribe, so importing this module costs nothing. */
function startLoading(): void {
    if (loading) return;
    loading = true;
    // Inside .then so a synchronous throw becomes a rejection too.
    Promise.resolve()
        .then(() =>
            createHighlighter({ themes: Object.values(SHIKI_THEMES), langs: PRELOADED_LANGS }),
        )
        .then((h) => {
            highlighter = h;
            notify();
        })
        .catch((err) => {
            console.warn("[taco] shiki failed to load; code blocks stay plain", err);
        });
}

export function subscribeHighlighter(listener: () => void): () => void {
    startLoading();
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** Bumps when the highlighter becomes ready and after each grammar batch loads. */
export function getHighlighterVersion(): number {
    return version;
}

/** The highlighter, or null while it is still loading (or failed to). */
export function getHighlighter(): Highlighter | null {
    return highlighter;
}

const FENCE_RE = /^ {0,3}(?:`{3,}|~{3,})[ \t]*([^\s`{]+)/gm;

/** Languages named by fence info strings in `markdown` (remark's `lang`: the first word). */
export function fenceLanguages(markdown: string): string[] {
    const out = new Set<string>();
    for (const match of markdown.matchAll(FENCE_RE)) {
        if (match[1]) out.add(match[1]);
    }
    return [...out];
}

/**
 * Start loading any bundled grammar in `langs` that is not loaded yet. Unknown
 * names are ignored — those blocks stay plain. No-op until the highlighter is
 * ready; callers re-run on the version bump that readiness brings.
 */
export function ensureLanguages(langs: readonly string[]): void {
    const h = highlighter;
    if (!h || langs.length === 0) return;
    const loaded = new Set(h.getLoadedLanguages());
    // hasOwn, not `in`: a ```constructor fence must not match Object.prototype.
    const missing = langs.filter(
        (lang) =>
            Object.hasOwn(bundledLanguages, lang) && !loaded.has(lang) && !requested.has(lang),
    ) as BundledLanguage[];
    if (missing.length === 0) return;
    for (const lang of missing) requested.add(lang);
    h.loadLanguage(...missing).then(notify, (err) => {
        console.warn("[taco] shiki grammar failed to load", missing, err);
    });
}
