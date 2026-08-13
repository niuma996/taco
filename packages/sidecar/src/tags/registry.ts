/**
 * Tag registry — single source of truth for all known tags and their specs
 * (compression policy / TUI visibility / parser).
 *
 * Built-in tags live in the frozen `BUILTIN_TAG_REGISTRY` literal; extensions
 * append at runtime via `registerExtensionTag`. Adding a new entry propagates
 * automatically to all policy helpers (pin / drop / visibility / pinAwareCompact).
 */

import { defineTag } from "./builder.ts";
import type { TagSpec } from "./types.ts";

/** Frozen builtin literal — drives the `as const` types and the eager
 *  `validateBuiltinRegistry()` check at module load. Do not mutate. */
const BUILTIN_TAG_REGISTRY = {
    /** Structured instructions loaded from CLAUDE.md / AGENTS.md / DESIGN.md. */
    instructions: defineTag({
        name: "instructions",
        scope: "system",
        compression: { kind: "drop" },
        tuiVisibility: "hidden",
        parser: { kind: "xml-balanced" },
        description: "Structured instructions loaded from CLAUDE.md / AGENTS.md / DESIGN.md",
    }),

    /** cwd + local date/time. Injected every LLM call. */
    env: defineTag({
        name: "env",
        scope: "system",
        compression: { kind: "drop" },
        tuiVisibility: "hidden",
        parser: { kind: "xml-balanced" },
        description: "Environment awareness block (cwd, OS, etc.)",
    }),

    /** IM channel identity (platform type + instance id). Injected for IM sessions. */
    im_channel: defineTag({
        name: "im_channel",
        scope: "system",
        compression: { kind: "drop" },
        tuiVisibility: "hidden",
        parser: { kind: "xml-balanced" },
        description: "IM channel awareness (type + channel_id) — injected for IM sessions only",
    }),

    /** Per-turn language directive from the desktop UI. */
    reply_language: defineTag({
        name: "reply_language",
        scope: "system",
        compression: { kind: "drop" },
        tuiVisibility: "hidden",
        parser: { kind: "xml-balanced" },
        description:
            "Per-turn directive: language the assistant must reply in, set by the desktop UI's current language.",
    }),

    /** Parsed askUser answers rehydrated into tool result details. */
    ask_user_context: defineTag({
        name: "ask_user_context",
        scope: "user-request",
        compression: { kind: "pin" },
        tuiVisibility: "hidden",
        parser: { kind: "xml-balanced" },
        description:
            "Injected askUser answer (questions + selected answers) — model-visible, hidden in TUI",
    }),

    /** Injected skill body content — survives compaction via reinjector. */
    skill_body: defineTag({
        name: "skill_body",
        scope: "system",
        compression: { kind: "pin" },
        tuiVisibility: "hidden",
        parser: { kind: "xml-balanced" },
        description: "Injected skill body content — pinned to survive context compaction",
    }),

    /** User-level memory from ~/.taco/memory/MEMORY.md. */
    memory: defineTag({
        name: "memory",
        scope: "user-context",
        compression: { kind: "pinOnce" },
        tuiVisibility: "hidden",
        parser: { kind: "xml-balanced" },
        description: "User-level memory context — appended from ~/.taco/memory/MEMORY.md",
    }),

    /** Continuation guidance for unfinished tasks. */
    active_tasks: defineTag({
        name: "active_tasks",
        scope: "user-context",
        compression: { kind: "drop" },
        tuiVisibility: "hidden",
        parser: { kind: "xml-balanced" },
        description: "Unfinished active-task guidance injected each turn (continue/terminate)",
    }),

    /** Injected once after each compaction to inform the model the context was compressed. */
    compaction_reminder: defineTag({
        name: "compaction_reminder",
        scope: "system",
        compression: { kind: "drop" },
        tuiVisibility: "hidden",
        parser: { kind: "xml-balanced" },
        description: "Post-compaction notification — fires once per compaction, then dropped",
    }),

    /** Injected when the model hasn't used TodoWrite for 10+ assistant turns with unfinished tasks. */
    todo_reminder: defineTag({
        name: "todo_reminder",
        scope: "system",
        compression: { kind: "drop" },
        tuiVisibility: "hidden",
        parser: { kind: "xml-balanced" },
        description: "Reminder to update the task list via TodoWrite when it goes stale",
    }),
} as const satisfies Record<string, TagSpec>;

/** Public mutable registry — seed from the frozen builtin literal at module
 *  load; extensions may append at runtime via `registerExtensionTag`. */
export const tagRegistry: Record<string, TagSpec> = { ...BUILTIN_TAG_REGISTRY };

const TAG_SCOPES = new Set<string>([
    "system",
    "user-context",
    "user-request",
    "assistant-output",
    "summary",
]);

const COMPRESSION_KINDS = new Set<string>(["pin", "pinOnce", "summarize", "drop"]);

const TUI_VISIBILITIES = new Set<string>(["visible", "hidden", "ephemeral"]);

const PARSER_KINDS = new Set<string>(["xml-balanced"]);

const BUILTIN_NAMES_SET = new Set<string>(Object.keys(BUILTIN_TAG_REGISTRY));

/**
 * Register an extension-supplied tag. Returns `true` on success; `false` on rejection.
 * Validates: name is non-empty, no builtin collision, not already registered
 * (first extension wins), scope/kind/visibility/parser are valid unions, description
 * is a string. Fail-isolation: never throws.
 */
export function registerExtensionTag(spec: TagSpec): boolean {
    if (!spec || typeof spec !== "object") return false;
    const { name } = spec;
    if (typeof name !== "string" || name.length === 0) return false;
    if (BUILTIN_NAMES_SET.has(name)) return false;
    if (Object.hasOwn(tagRegistry, name)) return false;
    if (!TAG_SCOPES.has(spec.scope as string)) return false;
    if (!COMPRESSION_KINDS.has(spec.compression.kind as string)) return false;
    if (!TUI_VISIBILITIES.has(spec.tuiVisibility as string)) return false;
    if (!PARSER_KINDS.has(spec.parser.kind as string)) return false;
    if (typeof spec.description !== "string") return false;

    tagRegistry[name] = defineTag(spec);
    return true;
}

/**
 * Eagerly validate the builtin registry.
 *
 * Runs once at module load on the *frozen* `BUILTIN_TAG_REGISTRY` literal.
 * Only checks that each spec's `name` matches its registry key. The registry
 * literal IS the source of truth — no external union is consulted.
 */
function validateBuiltinRegistry(): void {
    for (const [key, spec] of Object.entries(BUILTIN_TAG_REGISTRY)) {
        if (spec.name !== key) {
            throw new Error(
                `[tags/registry] spec.name mismatch for key "${key}": spec.name="${spec.name}".`,
            );
        }
    }
}

validateBuiltinRegistry();
