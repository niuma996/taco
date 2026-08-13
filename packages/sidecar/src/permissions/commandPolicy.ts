import type {
    CommandEvaluation,
    CommandPermissionConfig,
    CommandPermissionRule,
    CommandRisk,
} from "@taco-ai/protocol";
import type { ImCommandPolicy } from "../channels/imWorkspacePolicy.ts";
import {
    isShellWrapperCommand,
    matchWildcardPattern,
    parsePermissionRule,
} from "./shellRuleMatching.ts";

const RISK_ORDER: Record<CommandRisk, number> = {
    readOnly: 0,
    workspaceWrite: 1,
    externalSideEffect: 2,
    destructive: 3,
    privilegeEscape: 4,
};

/**
 * Exact commands (after normalization) that are considered read-only and safe.
 * Arguments must also be safe literals: no redirects, pipes, command
 * substitution, globs, semicolons, or backticks.
 */
const READ_ONLY = new Set([
    "pwd",
    "ls",
    "which",
    "git status",
    "git diff",
    "git log",
    "git show",
    "git branch",
    "git remote -v",
]);

const DESTRUCTIVE: Array<[RegExp, string]> = [
    [/\bgit\s+reset\s+--hard\b/, "may discard uncommitted changes"],
    [/\bgit\s+clean\b[^\n;&|]*-[a-zA-Z]*f/, "may permanently delete untracked files"],
    [/\bgit\s+push\b[^\n;&|]*(--force|--force-with-lease|-f)\b/, "may overwrite remote history"],
    [
        /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f|\brm\s+-[a-zA-Z]*f[a-zA-Z]*r/i,
        "may recursively force-remove files",
    ],
    [/\b(drop|truncate)\s+(table|database|schema)\b/i, "may drop database objects"],
    [/\bterraform\s+destroy\b/, "may destroy infrastructure"],
    [/\bkubectl\s+delete\b/, "may delete Kubernetes resources"],
];

const PRIVILEGE_ESCAPE: Array<[RegExp, string]> = [
    [/\b(sudo|doas)\b/, "requires elevated system privileges"],
    [/\b(mkfs|diskutil\s+eraseDisk)\b/, "may erase a disk"],
    [/\bchmod\s+(-R\s+)?777\b/, "may make files world-writable"],
];

function normalize(command: string): string {
    return command.trim().replace(/\s+/g, " ");
}

const SHELL_METACHARACTERS = /[<>|;&$`\n(){}[\]*?]/;

const SAFE_LITERAL = /^--?[A-Za-z0-9_-]+$|^[A-Za-z0-9_.-]+$/;

function containsShellSyntax(command: string): boolean {
    return SHELL_METACHARACTERS.test(command);
}

function splitCommand(command: string): string[] {
    return command
        .split(/(?:&&|\|\||;|\n|\|)/)
        .map((part) => part.trim())
        .filter(Boolean);
}

function evaluatePart(command: string): Pick<CommandEvaluation, "risk" | "reason"> {
    if (command.includes("$(") || command.includes("`")) {
        return {
            risk: "workspaceWrite",
            reason: "command substitution may execute arbitrary code",
        };
    }
    for (const [pattern, reason] of PRIVILEGE_ESCAPE) {
        if (pattern.test(command)) return { risk: "privilegeEscape", reason };
    }
    for (const [pattern, reason] of DESTRUCTIVE) {
        if (pattern.test(command)) return { risk: "destructive", reason };
    }
    if (
        /\b(git\s+push|npm\s+publish|pnpm\s+publish|yarn\s+publish|curl\s+.*-X\s*(POST|PUT|PATCH|DELETE)|wget\s+)/i.test(
            command,
        )
    ) {
        return {
            risk: "externalSideEffect",
            reason: "may change remote state or send network data",
        };
    }
    const token = command.match(/^[A-Za-z0-9._-]+(?:\s+[A-Za-z0-9._-]+)*/)?.[0] ?? "";
    if (READ_ONLY.has(token)) return { risk: "readOnly", reason: "recognized read-only command" };
    return { risk: "workspaceWrite", reason: "command may change the workspace" };
}

function matchesRule(command: string, rules: CommandPermissionRule[]): boolean {
    const normalized = normalize(command);
    const first = normalized.split(" ")[0] ?? "";
    if (isShellWrapperCommand(first)) return false;
    return rules.some((rule) => {
        const parsed = parsePermissionRule(rule);
        if (parsed.type === "exact") return normalized === parsed.command;
        return matchWildcardPattern(parsed.pattern, normalized);
    });
}

/** Commands whose base form is read-only but whose arguments can change risk. */
const READ_ONLY_BASES = new Set(["git branch", "git checkout"]);

/**
 * Returns true if the command is an exact, safe form of a known read-only
 * command with no shell metacharacters. Benign literal flags are allowed after
 * the recognized base command.
 */
export function isStrictReadOnly(command: string): boolean {
    const normalized = normalize(command);
    if (containsShellSyntax(normalized)) return false;

    const parts = normalized.split(/\s+/);
    if (parts.length === 0) return false;

    const first = parts[0] ?? "";
    if (isShellWrapperCommand(first)) return false;

    // Find the longest READ_ONLY prefix, e.g. "git remote -v".
    let matchedTokens = 1;
    while (matchedTokens <= parts.length) {
        const token = parts.slice(0, matchedTokens).join(" ");
        if (READ_ONLY.has(token)) break;
        if (matchedTokens === parts.length) return false;
        matchedTokens++;
    }

    const base = parts.slice(0, matchedTokens).join(" ");
    // Read-only bases with mutating flags remain ask-only.
    if (READ_ONLY_BASES.has(base)) return false;

    // Every remaining argument must be a simple literal flag/value.
    for (let i = matchedTokens; i < parts.length; i++) {
        const part = parts[i] ?? "";
        if (containsShellSyntax(part)) return false;
        if (!SAFE_LITERAL.test(part)) return false;
    }
    return true;
}

/**
 * Classify a (possibly compound) command's highest-risk segment. Shared by the
 * global and IM evaluators so their risk reduction can never drift.
 */
function classifyRisk(command: string): Pick<CommandEvaluation, "risk" | "reason"> {
    const parts = splitCommand(command);
    return parts.reduce<Pick<CommandEvaluation, "risk" | "reason">>(
        (highest, part) => {
            const next = evaluatePart(part);
            return RISK_ORDER[next.risk] > RISK_ORDER[highest.risk] ? next : highest;
        },
        { risk: "readOnly", reason: "empty command" },
    );
}

export function evaluateCommand(
    command: string,
    config: CommandPermissionConfig,
): CommandEvaluation {
    const riskResult = classifyRisk(command);

    if (riskResult.risk === "privilegeEscape") {
        return { behavior: "deny", ...riskResult };
    }
    if (riskResult.risk === "destructive" || riskResult.risk === "externalSideEffect") {
        return { behavior: "ask", ...riskResult };
    }
    if (matchesRule(command, config.rules)) {
        return { behavior: "allow", ...riskResult, source: "rule" };
    }
    if (config.mode === "auto" && isStrictReadOnly(command)) {
        return { behavior: "allow", ...riskResult, source: "mode" };
    }
    return { behavior: "ask", ...riskResult };
}

/**
 * Channel-aware shell evaluation for IM workspaces.
 *
 * Decision order (per the design doc §命令裁决):
 *   1. privilege escape → deny (never overridable);
 *   2. channel/chat deny rule → deny;
 *   3. auto mode: destructive / external side effect → deny — stricter than
 *      the global evaluator's ask, because an IM chat has no interactive
 *      approval path (ask would hang until the broker timeout and deny anyway);
 *   4. allow list present but unmatched → deny;
 *   5. auto + allow rule matched → allow; auto without an allow list only
 *      passes strict read-only commands;
 *   6. ask mode reproduces the global evaluator.
 *
 * In auto mode every segment of a compound command must satisfy the allow
 * list; a single unmatched segment denies the whole command.
 */
export function evaluateCommandForImWorkspace(
    command: string,
    config: CommandPermissionConfig,
    policy: ImCommandPolicy,
): CommandEvaluation {
    const parts = splitCommand(command);
    const riskResult = classifyRisk(command);

    if (riskResult.risk === "privilegeEscape") {
        return { behavior: "deny", ...riskResult };
    }
    if (policy.mode === "ask") {
        return evaluateCommand(command, config);
    }

    // From here on: auto mode.
    // Deny is checked PER SEGMENT: matchesRule anchors on the start of the
    // string it is given, so passing the whole compound command would let
    // `ls && cat /etc/passwd` slip past a `cat *` deny rule.
    if (policy.deny && parts.some((part) => matchesRule(part, policy.deny ?? []))) {
        return {
            behavior: "deny",
            ...riskResult,
            source: "channel",
            reason: "denied by channel rule",
        };
    }
    if (riskResult.risk === "destructive" || riskResult.risk === "externalSideEffect") {
        return { behavior: "deny", ...riskResult, source: "channel" };
    }
    if (policy.allow) {
        const allAllowed = parts.every((part) => matchesRule(part, policy.allow ?? []));
        if (!allAllowed) {
            return {
                behavior: "deny",
                ...riskResult,
                source: "channel",
                reason: "command not allowed by channel allow list",
            };
        }
        return { behavior: "allow", ...riskResult, source: "channel" };
    }
    // No allow list: fall back to the global evaluator, upgrading ask → allow
    // only for strict read-only commands (no shell metacharacters).
    const base = evaluateCommand(command, config);
    if (base.behavior === "allow") return { ...base, source: "channel" };
    if (isStrictReadOnly(command)) return { behavior: "allow", ...riskResult, source: "channel" };
    return base;
}
