/**
 * Tag system types. Tags are XML blocks in message content with a compression
 * policy (pin/summarize/drop) and tui visibility (visible/hidden/ephemeral).
 */

/** Well-known tag name — builtin tags live as keys in `BUILTIN_TAG_REGISTRY`,
 *  extension tags are arbitrary strings. No closed union — single source of
 *  truth is the registry literal at `tags/registry.ts`. */
export type TagName = string;

/** Which phase of processing a tag applies to. */
export type TagScope = "system" | "user-context" | "user-request" | "assistant-output" | "summary";

/** How a tag's body is handled during context compression. */
export type CompressionPolicy =
    | { readonly kind: "pin" }
    | { readonly kind: "pinOnce" }
    | { readonly kind: "summarize" }
    | { readonly kind: "drop" };

/** How the tag's content boundaries are determined. Sole kind — add a new variant when a real use case appears. */
export type ParserKind = { readonly kind: "xml-balanced" };

/** Immutable tag specification. Use `defineTag()` to construct — it deep-freezes the spec. */
export interface TagSpec {
    readonly name: TagName;
    readonly scope: TagScope;
    readonly compression: CompressionPolicy;
    /** Whether the tag is visible to the user in the TUI. */
    readonly tuiVisibility: "visible" | "hidden" | "ephemeral";
    readonly parser: ParserKind;
    /** Human-readable description for tooling / debug output. */
    readonly description: string;
}

/** A pinned segment extracted from a message during compression. */
export interface PinnedSegment {
    readonly name: TagName;
    readonly content: string;
    readonly attrs: Readonly<Record<string, string>>;
    /** Unique instance identifier — used to track pinOnce consumption across compressions. */
    readonly instanceId: string;
}

/**
 * Result of parsing a balanced XML tag from a string.
 * `range` is the half-open interval [start, end) in the original string.
 */
export interface BalancedTag {
    readonly inner: string;
    readonly attrs: Readonly<Record<string, string>>;
    readonly range: readonly [number, number];
}
