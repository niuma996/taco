/**
 * Client-side mirror of `shellRuleMatching.validatePermissionRule` — runs in the
 * renderer before we call settingsWrite so the user sees an immediate error
 * instead of a silently dropped rule. Keep in sync with the sidecar version;
 * any new shell wrapper added there must be added here too.
 */

const SHELL_WRAPPERS = new Set([
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

export type ClientRuleValidation =
    | { valid: true; canonical: string }
    | { valid: false; reason: ClientRuleValidationError };

export type ClientRuleValidationError = { kind: "empty" } | { kind: "shellWrapper"; shell: string };

export function validatePermissionRuleClient(rule: string): ClientRuleValidation {
    const trimmed = rule.trim();
    if (trimmed.length === 0) {
        return { valid: false, reason: { kind: "empty" } };
    }
    const first = trimmed.split(/\s+/)[0]?.toLowerCase() ?? "";
    if (SHELL_WRAPPERS.has(first)) {
        return { valid: false, reason: { kind: "shellWrapper", shell: first } };
    }
    return { valid: true, canonical: trimmed };
}
