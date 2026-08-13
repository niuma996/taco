/**
 * Shell command permission rule matching — port of Claude Code's shellRuleMatching.ts.
 *
 * Pattern syntax (auto-detected, no `kind` field):
 *   - exact:      `npm install`        — literal match
 *   - wildcard:   `mmx *`, `git *`, `* install` — `*` matches any sequence
 *
 * Escape syntax: `\*` (literal asterisk), `\\` (literal backslash).
 */

import type { CommandPermissionRule } from "@taco-ai/protocol";

// Null-byte sentinel placeholders for escaped wildcards — compiled once.
const ESCAPED_STAR = "\x00ESC_STAR\x00";
const ESCAPED_BACKSLASH = "\x00ESC_BSLASH\x00";

/**
 * Commands that wrap arbitrary code and must never be the base of an allow
 * rule (a rule like `bash *` would always be too permissive — `bash -c 'rm -rf /'`
 * would slip through). Same list gates rule validation here and the broker's
 * first-token gate in `commandPolicy.matchesRule`.
 */
export const SHELL_WRAPPERS: ReadonlySet<string> = new Set([
    "bash",
    "sh",
    "zsh",
    "fish",
    "env",
    "sudo",
    "doas",
    "powershell",
    "cmd",
]);

/**
 * Whether the first token of a command is a shell wrapper. Case-insensitive —
 * `BASH`, `Bash` and `bash` all match, so a case-mismatched rule can never
 * slip past the gate. Accepts an already-split first token; empty token is
 * never a wrapper.
 */
export function isShellWrapperCommand(firstToken: string): boolean {
    return SHELL_WRAPPERS.has(firstToken.toLowerCase());
}

/** Parsed permission rule discriminated union. */
export type ParsedRule = { type: "exact"; command: string } | { type: "wildcard"; pattern: string };

/**
 * Check if a pattern contains unescaped wildcards.
 * An asterisk is unescaped if preceded by an even number of backslashes.
 */
function hasWildcards(pattern: string): boolean {
    for (let i = 0; i < pattern.length; i++) {
        if (pattern[i] !== "*") continue;
        let bs = 0;
        let j = i - 1;
        while (j >= 0 && pattern[j] === "\\") {
            bs++;
            j--;
        }
        if (bs % 2 === 0) return true;
    }
    return false;
}

/** Parse a permission rule string into a structured rule object. */
export function parsePermissionRule(rule: string): ParsedRule {
    if (hasWildcards(rule)) {
        return { type: "wildcard", pattern: rule };
    }
    return { type: "exact", command: rule };
}

/**
 * Match a command against a wildcard pattern.
 *
 * @param pattern — the permission rule pattern (may contain unescaped `*`)
 * @param command — the normalized command to test
 */
export function matchWildcardPattern(pattern: string, command: string): boolean {
    const trimmed = pattern.trim();

    let processed = "";
    let i = 0;
    while (i < trimmed.length) {
        if (trimmed[i] === "\\" && i + 1 < trimmed.length) {
            const next = trimmed[i + 1];
            if (next === "*") {
                processed += ESCAPED_STAR;
                i += 2;
                continue;
            }
            if (next === "\\") {
                processed += ESCAPED_BACKSLASH;
                i += 2;
                continue;
            }
        }
        processed += trimmed[i];
        i++;
    }

    // Escape regex special characters except *
    const escaped = processed.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

    // Convert unescaped * to .*
    const withWildcards = escaped.replace(/\*/g, ".*");

    // Restore placeholders to escaped regex literals
    let regexPattern = withWildcards
        .replace(new RegExp(ESCAPED_STAR, "g"), "\\*")
        .replace(new RegExp(ESCAPED_BACKSLASH, "g"), "\\\\");

    // When a pattern ends with ' *' and that asterisk is the only unescaped
    // wildcard, make the trailing space+args optional: `git *` matches both
    // `git` and `git add`.
    const unescapedStarCount = (processed.match(/\*/g) ?? []).length;
    if (regexPattern.endsWith(" .*") && unescapedStarCount === 1) {
        regexPattern = `${regexPattern.slice(0, -3)}( .*)?`;
    }

    const re = new RegExp(`^${regexPattern}$`, "s");
    return re.test(command);
}

/** Validate a single permission rule string. Returns the canonical form on success. */
export function validatePermissionRule(
    rule: string,
): { valid: true; canonical: CommandPermissionRule } | { valid: false; reason: string } {
    const trimmed = rule.trim();
    if (trimmed.length === 0) {
        return { valid: false, reason: "rule must not be empty" };
    }
    // Reject shell wrappers as the base command
    const first = trimmed.split(/\s+/)[0]?.toLowerCase() ?? "";
    if (isShellWrapperCommand(first)) {
        return { valid: false, reason: `shell wrapper "${first}" is not allowed in rules` };
    }
    return { valid: true, canonical: trimmed };
}
