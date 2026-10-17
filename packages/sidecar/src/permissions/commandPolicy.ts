import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
    CommandEvaluation,
    CommandPermissionConfig,
    CommandPermissionRule,
    CommandRisk,
} from "@taco-ai/protocol";
import type { ImCommandPolicy } from "../channels/imWorkspacePolicy.ts";
import type { ParsedShellNode, ShellLanguage } from "./shellParser.ts";
import { parseShellCommand } from "./shellParser.ts";
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
 * substitution, globs, semicolons, or backticks. Tokens that mutate the
 * filesystem or spawn processes live in {@link READ_ONLY_FORBIDDEN_FLAGS} and
 * are rejected by {@link isStrictReadOnly} regardless of base.
 */
const READ_ONLY = new Set([
    "pwd",
    "ls",
    "which",
    "find",
    "cat",
    "head",
    "tail",
    "wc",
    "file",
    "stat",
    "du",
    "df",
    "echo",
    "grep",
    "diff",
    "sort",
    "uniq",
    "cut",
    "tr",
    "basename",
    "dirname",
    "realpath",
    "readlink",
    "date",
    "hostname",
    "uname",
    "whoami",
    "id",
    "md5sum",
    "sha256sum",
    "xxd",
    "od",
    "git status",
    "git diff",
    "git log",
    "git show",
    "git branch",
    "git remote",
    "git remote -v",
    "git remote get-url",
    "git blame",
    "git rev-parse",
    "git ls-files",
    "git ls-tree",
    "git describe",
    "git merge-base",
    "git rev-list",
    "git shortlog",
    "git cat-file",
    "git show-ref",
    "git for-each-ref",
    "git name-rev",
    "git check-ignore",
    "git version",
    "git --version",
    "git help",
    "git reflog",
    // Dual-use parents (`git stash`, `git config`, `git tag`, `git worktree`)
    // stay out of the set except the listed read-only forms, so mutating
    // siblings (`stash apply`, `config user.email x`, `tag v1`) keep asking.
    // `git branch` is in the set so a bare listing auto-allows; extra
    // positional args still create a branch and are rejected below.
    "git stash list",
    "git stash show",
    "git config --get",
    "git config --get-all",
    "git config --get-regexp",
    "git config --list",
    "git config -l",
    "git worktree list",
    "git submodule status",
    "git tag --list",
    "git tag -l",
]);

/**
 * Flags that mutate the filesystem or execute arbitrary commands. Listed
 * here (rather than per-base) because flag values like `-mtime -7` or
 * `-size +1k` legitimately start with `-`/`+` and a per-base whitelist
 * cannot distinguish them from flags. `find`'s mutating predicates and
 * `git cat-file`'s filter/command-stream flags share this set.
 */
const READ_ONLY_FORBIDDEN_FLAGS: ReadonlySet<string> = new Set([
    "-delete",
    "-exec",
    "-execdir",
    "-ok",
    "-okdir",
    "-fprint",
    "-fprint0",
    "-fls",
    "-fprintf",
    // git cat-file: these spawn filters / read a command stream from stdin.
    "--textconv",
    "--filters",
    "--batch-command",
    // git diff/log: writes the diff to a file instead of stdout.
    "--output",
    "--ext-diff",
    "--exec-path",
    "-o",
    "--set",
]);

/**
 * Dual-use git prefixes (`git branch`, `git stash show`, `git config --get`,
 * …) auto-allow only while extra tokens stay non-mutating. Positional names
 * after `git branch` create a branch, so that parent additionally requires
 * remaining tokens to be flags.
 *
 * Matched against the token's stem (`--set-upstream-to=x` → `--set-upstream-to`)
 * so an attached value cannot dodge the check.
 */
const GIT_DUAL_USE_MUTATING_TOKENS: ReadonlySet<string> = new Set([
    "-D",
    "-d",
    "-m",
    "-M",
    "-f",
    "-c",
    "-C",
    "--force",
    "--delete",
    "--edit",
    "--unset",
    "--unset-all",
    "--replace-all",
    "--add",
    "--remove",
    "--track",
    "--copy",
    "--move",
    // `git branch` upstream/description flags write branch config or spawn $EDITOR.
    "--set-upstream",
    "--set-upstream-to",
    "--unset-upstream",
    "--edit-description",
    // `git help -w` opens a browser. Scoped to the dual-use bases so plain
    // `-w` (grep word-match, `git log -w` whitespace) is unaffected.
    "-w",
    "--web",
    "expire",
    "delete",
    "apply",
    "drop",
    "pop",
    "push",
    "add",
    "remove",
    "update",
    "prune",
    "move",
    "rename",
    "edit",
    "create",
    "set-url",
    "set-head",
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
    [/^(?:sudo|doas)\b/i, "requires elevated system privileges"],
    [/^(?:mkfs|diskutil\s+eraseDisk)\b/i, "may erase a disk"],
    [/^chmod\s+(-R\s+)?777\b/i, "may make files world-writable"],
];

function normalize(command: string): string {
    return command.trim().replace(/\s+/g, " ");
}

/**
 * Drop the common `git --no-pager` global so inspection commands still match
 * the read-only set. Other globals (`-C`, `-c`, `--git-dir`) stay: they can
 * retarget the repo or inject aliases.
 */
function stripSafeGitGlobals(command: string): string {
    return command.replace(/^git --no-pager /, "git ");
}

/**
 * `--output=/tmp/x` → `--output`; bare tokens unchanged. Flag checks match on
 * the stem so an attached value cannot dodge them.
 */
function flagStem(token: string): string {
    const eq = token.indexOf("=");
    return eq === -1 ? token : token.slice(0, eq);
}

const SHELL_METACHARACTERS = /[<>|;&$`\n(){}[\]*?]/;

// Colon / tilde / caret / at / percent show up in git revisions
// (`HEAD:path`, `HEAD~1`, `main^2`, `@`, `--pretty=format:%s`). None of
// these are shell metacharacters, so they stay in the literal class.
const SAFE_LITERAL = /^--?[A-Za-z0-9_+/,+=:@^~%-]+$|^[A-Za-z0-9_./,+=:@^~%-]+$/;

function containsShellSyntax(command: string): boolean {
    return SHELL_METACHARACTERS.test(command);
}

function evaluatePart(command: string): Pick<CommandEvaluation, "risk" | "reason"> {
    command = stripSafeGitGlobals(normalize(command));
    if (command.includes("$(") || command.includes("`")) {
        return {
            risk: "workspaceWrite",
            reason: "command substitution may execute arbitrary code",
        };
    }
    // Shell metacharacters change the base command's behavior (redirects,
    // globs, subshells). A read-only base with a `>` redirect still writes,
    // so report workspaceWrite instead of inheriting the base's risk.
    if (containsShellSyntax(command)) {
        return {
            risk: "workspaceWrite",
            reason: "shell metacharacters change the base command's behavior",
        };
    }
    for (const [pattern, reason] of PRIVILEGE_ESCAPE) {
        if (pattern.test(command)) return { risk: "privilegeEscape", reason };
    }
    for (const [pattern, reason] of DESTRUCTIVE) {
        if (pattern.test(command)) return { risk: "destructive", reason };
    }
    if (
        /\b(git\s+push|npm\s+publish|pnpm\s+publish|yarn\s+publish|curl\s+.*-X\s*(POST|PUT|PATCH|DELETE)|curl\s+(.*\s)?(-d\S*|--data\S*|-F\S*|--form\S*|-T\S*|--upload-file|--json)(\s|=|$)|wget\s+)/i.test(
            command,
        )
    ) {
        return {
            risk: "externalSideEffect",
            reason: "may change remote state or send network data",
        };
    }
    // Longest-prefix READ_ONLY match: mirrors isStrictReadOnly's base
    // detection so `find . -name foo` reports the base command's risk
    // (readOnly) instead of failing to find a multi-token entry.
    const parts = command.split(/\s+/);
    let matchedPrefix = "";
    for (let i = 1; i <= parts.length; i++) {
        const candidate = parts.slice(0, i).join(" ");
        if (READ_ONLY.has(candidate)) matchedPrefix = candidate;
    }
    if (matchedPrefix) {
        return { risk: "readOnly", reason: "recognized read-only command" };
    }
    return { risk: "workspaceWrite", reason: "command may change the workspace" };
}

/**
 * Persistent approvals store the verbatim command, so only an exact rule may
 * allow a compound command as a whole. Compared without whitespace collapsing:
 * `ls\nrm foo` must not equal the single command `ls rm foo`.
 */
function exactCommandRule(
    command: string,
    rules: readonly CommandPermissionRule[],
): CommandPermissionRule | undefined {
    const trimmed = command.trim();
    return rules.find(
        (rule) => parsePermissionRule(rule).type === "exact" && rule.trim() === trimmed,
    );
}

function matchingRule(
    command: string,
    rules: readonly CommandPermissionRule[],
    allowWrapper = false,
): CommandPermissionRule | undefined {
    const normalized = normalize(command);
    if (!allowWrapper && isShellWrapperCommand(normalized.split(" ")[0] ?? "")) return undefined;
    return rules.find((rule) => {
        const parsed = parsePermissionRule(rule);
        return parsed.type === "exact"
            ? normalized === normalize(parsed.command)
            : matchWildcardPattern(parsed.pattern, normalized);
    });
}

/**
 * Commands whose base form is read-only but whose arguments can change risk.
 * `git checkout` is not in {@link READ_ONLY}; it lives here so a future
 * listing still cannot auto-allow `git checkout -- .`. `git branch` used to
 * sit here too — it now auto-allows when remaining tokens are non-mutating
 * flags (see {@link extraGitArgsAreSafe}).
 */
const READ_ONLY_BASES = new Set(["git checkout"]);
// Strict read-only Git inspection runs without a prompt even in manual mode;
// other read-only utilities remain approval-gated there.
const MANUAL_SAFE =
    /^(git\s+(status|diff|log|show|branch|remote|blame|rev-parse|ls-files|ls-tree|describe|merge-base|rev-list|shortlog|cat-file|show-ref|for-each-ref|name-rev|check-ignore|version|help|reflog|stash\s+(list|show)|config\s+--(?:get|get-all|get-regexp|list)|config\s+-l|worktree\s+list|submodule\s+status|tag\s+(--list|-l)))(?:\s|$)/;

function isGitDualUseBase(base: string): boolean {
    return (
        base.startsWith("git help") ||
        base.startsWith("git branch") ||
        base.startsWith("git tag") ||
        base.startsWith("git config") ||
        base.startsWith("git stash") ||
        base.startsWith("git worktree") ||
        base.startsWith("git submodule") ||
        base.startsWith("git remote") ||
        base.startsWith("git reflog")
    );
}

function extraGitArgsAreSafe(base: string, remaining: readonly string[]): boolean {
    if (!isGitDualUseBase(base)) return true;
    for (const part of remaining) {
        if (GIT_DUAL_USE_MUTATING_TOKENS.has(flagStem(part))) return false;
    }
    // `git branch newbranch` creates a branch; `git remote show` contacts the
    // remote. Remaining tokens on those short parents must be flags.
    if (base === "git branch" || base === "git remote") {
        return remaining.every((part) => part.startsWith("-"));
    }
    return true;
}

/**
 * Returns true if the command is an exact, safe form of a known read-only
 * command with no shell metacharacters. Benign literal flags are allowed after
 * the recognized base command.
 */
export function isStrictReadOnly(command: string): boolean {
    const normalized = stripSafeGitGlobals(normalize(command));
    if (containsShellSyntax(normalized)) return false;

    const parts = normalized.split(/\s+/);
    if (
        (parts[0] === "date" && parts.length > 1) ||
        (parts[0] === "xxd" && parts.includes("-r")) ||
        (parts[0] === "uniq" && parts.filter((part) => !part.startsWith("-")).length > 2)
    )
        return false;
    if (parts.length === 0) return false;

    const first = parts[0] ?? "";
    if (isShellWrapperCommand(first)) return false;

    // Longest READ_ONLY prefix, e.g. "git remote get-url" over "git remote".
    let matchedTokens = 0;
    for (let i = 1; i <= parts.length; i++) {
        if (READ_ONLY.has(parts.slice(0, i).join(" "))) matchedTokens = i;
    }
    if (matchedTokens === 0) return false;

    const base = parts.slice(0, matchedTokens).join(" ");
    // Read-only bases with mutating flags remain ask-only.
    if (READ_ONLY_BASES.has(base)) return false;

    const remaining = parts.slice(matchedTokens);
    if (!extraGitArgsAreSafe(base, remaining)) return false;

    // Remaining tokens must be simple literals. The blacklist covers find's
    // mutating predicates and git cat-file's filter/command-stream flags.
    for (const part of remaining) {
        if (containsShellSyntax(part)) return false;
        if (READ_ONLY_FORBIDDEN_FLAGS.has(flagStem(part))) return false;
        if (!SAFE_LITERAL.test(part)) return false;
    }
    return true;
}

export interface CommandEvaluationContext {
    cwd?: string;
    allowedRoots?: readonly string[];
    language?: ShellLanguage;
}

function authorizedDirectory(
    target: string,
    cwd: string,
    roots: readonly string[],
): string | undefined {
    try {
        // Canonicalize the target before later relative changes: symlinks must
        // not turn a lexically contained path into an external working directory.
        const absolute = realpathSync(resolve(cwd, target));
        if (!statSync(absolute).isDirectory()) return undefined;
        return roots.some((root) => {
            const rel = relative(realpathSync(root), absolute);
            return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
        })
            ? absolute
            : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Commands that execute their arguments as another command. The inner command
 * is invisible to risk classification, so they always ask, like shell wrappers.
 */
const COMMAND_RUNNERS: ReadonlySet<string> = new Set([
    "eval",
    "exec",
    "source",
    ".",
    "xargs",
    "nohup",
    "time",
    "nice",
    "timeout",
    "watch",
    "command",
    "builtin",
    "parallel",
    "stdbuf",
    "setsid",
    "invoke-expression",
    "iex",
    "invoke-command",
    "icm",
    "start-process",
    "saps",
    "start",
    "start-job",
]);

function isCommandRunner(argv: readonly string[]): boolean {
    const first = argv[0]?.toLowerCase() ?? "";
    // `command -v node` only looks a command up.
    if (first === "command" && /^-[vV]$/.test(argv[1] ?? "")) return false;
    return COMMAND_RUNNERS.has(first);
}

// Git globals whose value is a separate token; the subcommand follows them.
const GIT_GLOBALS_WITH_VALUE: ReadonlySet<string> = new Set([
    "-C",
    "-c",
    "--git-dir",
    "--work-tree",
    "--namespace",
    "--exec-path",
    "--super-prefix",
    "--config-env",
]);

/** `git -C . push` → `git push`, so global options cannot hide a risky subcommand. */
function withoutGitGlobals(argv: readonly string[]): string[] {
    if (argv[0]?.toLowerCase() !== "git") return [...argv];
    let index = 1;
    for (let arg = argv[index]; arg?.startsWith("-"); arg = argv[index]) {
        index += GIT_GLOBALS_WITH_VALUE.has(arg) ? 2 : 1;
    }
    return ["git", ...argv.slice(index)];
}

const POWERSHELL_REMOVE = new Set(["remove-item", "ri", "rm", "rmdir", "rd", "del", "erase"]);
const POWERSHELL_WEB = new Set(["invoke-webrequest", "iwr", "invoke-restmethod", "irm"]);

/** Argument-order-insensitive checks the regex tables cannot express. */
function argvRisk(
    argv: readonly string[],
    language: ShellLanguage,
): Pick<CommandEvaluation, "risk" | "reason"> | undefined {
    const first = argv[0]?.toLowerCase() ?? "";
    const args = argv.slice(1);
    if (
        (isShellWrapperCommand(first) || isCommandRunner(argv)) &&
        args.some((arg) => /^(?:sudo|doas)\b/i.test(arg))
    ) {
        return { risk: "privilegeEscape", reason: "requires elevated system privileges" };
    }
    if (language === "powershell") {
        const params = args.map((arg) => arg.toLowerCase());
        if (first === "format-volume" || first === "clear-disk")
            return { risk: "privilegeEscape", reason: "may erase a disk" };
        if (
            POWERSHELL_REMOVE.has(first) &&
            params.some((p) => p.length > 1 && "-recurse".startsWith(p))
        ) {
            return { risk: "destructive", reason: "may recursively remove files" };
        }
        if (
            POWERSHELL_WEB.has(first) &&
            params.some(
                (p, i) =>
                    p === "-body" ||
                    p === "-infile" ||
                    (p === "-method" && !/^(get|head|options)$/i.test(params[i + 1] ?? "")),
            )
        ) {
            return {
                risk: "externalSideEffect",
                reason: "may change remote state or send network data",
            };
        }
        return undefined;
    }
    if (first === "rm") {
        const end = args.indexOf("--");
        const flags = (end === -1 ? args : args.slice(0, end)).filter((arg) => arg.startsWith("-"));
        const short = flags.filter((flag) => !flag.startsWith("--")).join("");
        const recursive = /[rR]/.test(short) || flags.includes("--recursive");
        const force = short.includes("f") || flags.includes("--force");
        if (recursive && force)
            return { risk: "destructive", reason: "may recursively force-remove files" };
    }
    return undefined;
}

const RISK_FLOOR: ReadonlySet<CommandRisk> = new Set(["destructive", "externalSideEffect"]);

function canonical(node: ParsedShellNode): string {
    return node.argv.join(" ");
}
function higherRisk<T extends Pick<CommandEvaluation, "risk">>(a: T, b: T | undefined): T {
    return b && RISK_ORDER[b.risk] > RISK_ORDER[a.risk] ? b : a;
}
function nodeRisk(
    node: ParsedShellNode,
    language: ShellLanguage,
): Pick<CommandEvaluation, "risk" | "reason"> {
    const stripped = withoutGitGlobals(node.argv);
    let value = evaluatePart(canonical(node));
    if (stripped.length !== node.argv.length)
        value = higherRisk(value, evaluatePart(stripped.join(" ")));
    value = higherRisk(value, argvRisk(stripped, language));
    if (
        value.risk === "privilegeEscape" ||
        value.risk === "destructive" ||
        value.risk === "externalSideEffect"
    )
        return value;
    return node.redirects || node.dynamic
        ? { risk: "workspaceWrite", reason: "shell syntax can change state" }
        : value;
}
const behaviorRank = { allow: 0, ask: 1, deny: 2 };
function aggregate(values: CommandEvaluation[]): CommandEvaluation {
    const highest = values.reduce((a, b) =>
        behaviorRank[b.behavior] > behaviorRank[a.behavior] ||
        (behaviorRank[b.behavior] === behaviorRank[a.behavior] && b.matchedList === "deny")
            ? b
            : a,
    );
    const risk = values.reduce(
        (a, b) => (RISK_ORDER[b.risk] > RISK_ORDER[a] ? b.risk : a),
        highest.risk,
    );
    return { ...highest, risk };
}

/** All callers share AST traversal; readonly callers never consult mode or rules. */
function evaluateParsed(
    command: string,
    config: CommandPermissionConfig,
    context: CommandEvaluationContext = {},
    readOnly = false,
): CommandEvaluation {
    const parsed = parseShellCommand(command, context.language);
    const values: CommandEvaluation[] = [];
    const roots = [
        ...(context.cwd ? [context.cwd] : []),
        ...(context.allowedRoots ?? []),
        ...(readOnly ? [] : (config.allowedDirectories ?? [])),
    ];
    let cwds = [context.cwd ?? process.cwd()];
    let successfulCd: string[] | undefined;
    const allowRules = config.allow ?? config.rules ?? [];
    const wholeDeny = matchingRule(command, config.deny ?? [], true);
    // Wildcard allow rules match per command only: `*` would otherwise span
    // `&&`, `;` and newlines and approve unrelated trailing commands.
    const wholeAllow = exactCommandRule(command, allowRules);
    for (const [index, node] of parsed.nodes.entries()) {
        const text = canonical(node);
        const gitStripped = withoutGitGlobals(node.argv).join(" ");
        const risk = nodeRisk(node, parsed.language);
        const result = (
            behavior: CommandEvaluation["behavior"],
            reason: string,
            extra: Partial<CommandEvaluation> = {},
        ): CommandEvaluation => ({
            behavior,
            ...risk,
            reason,
            triggeringCommand: node.text,
            ...extra,
        });
        // Evaluate every node before reducing, including commands nested in
        // unsupported syntax, so an earlier ask never masks a hard refusal.
        if (risk.risk === "privilegeEscape") {
            values.push(result("deny", risk.reason));
            continue;
        }
        const denied =
            wholeDeny ??
            matchingRule(text, config.deny ?? [], true) ??
            matchingRule(gitStripped, config.deny ?? [], true);
        if (!readOnly && denied)
            values.push(
                result("ask", "command matched deny list", {
                    source: "rule",
                    matchedList: "deny",
                    matchedRule: denied,
                }),
            );
        // A runner's inner command is opaque, so only an exact persisted
        // approval of that very command lets it through.
        if (
            node.kind === "command" &&
            !node.dynamic &&
            isCommandRunner(node.argv) &&
            !RISK_FLOOR.has(risk.risk)
        ) {
            const exact = exactCommandRule(text, allowRules) ?? wholeAllow;
            values.push(
                exact
                    ? result("allow", "command matched allow list", {
                          source: "rule",
                          matchedList: "allow",
                          matchedRule: exact,
                      })
                    : result(readOnly ? "deny" : "ask", "command runs another command"),
            );
            continue;
        }
        if (node.kind === "unknown" || node.dynamic || isShellWrapperCommand(node.argv[0] ?? "")) {
            values.push(result(readOnly ? "deny" : "ask", "unsupported or dynamic shell command"));
            continue;
        }
        if (successfulCd && node.operator === "&&") cwds = successfulCd;
        successfulCd = undefined;
        if (node.kind === "cd") {
            const piped = node.operator === "|" || parsed.nodes[index + 1]?.operator === "|";
            const target = node.cwd;
            const destinations = target
                ? cwds.map((cwd) => authorizedDirectory(target, cwd, roots))
                : [];
            const safe =
                !piped &&
                destinations.length > 0 &&
                destinations.every((path) => path !== undefined);
            if (!safe) {
                values.push(
                    result(
                        readOnly ? "deny" : "ask",
                        "directory change cannot be proven inside authorized directories",
                    ),
                );
                continue;
            }
            successfulCd = destinations as string[];
            // A successful `cd` changes the process cwd for the following
            // sequential command; retaining the old alternatives would let a
            // later relative `cd` resolve from the wrong branch.
            cwds = [...new Set(successfulCd)];
            values.push(
                result("allow", "authorized directory change", {
                    risk: "readOnly",
                    source: "mode",
                }),
            );
            continue;
        }
        const strict = !node.redirects && isStrictReadOnly(text);
        if (readOnly) {
            values.push(
                result(
                    strict ? "allow" : "deny",
                    strict
                        ? "recognized read-only command"
                        : "read-only execution refuses mutating commands",
                    { risk: strict ? "readOnly" : risk.risk },
                ),
            );
            continue;
        }
        if (denied) continue;
        // Built-in denylist: the pre-allowlist safety floor. No rule or mode
        // overrides it, and its approvals stay once-only via matchedList.
        if (RISK_FLOOR.has(risk.risk)) {
            values.push(result("ask", risk.reason, { source: "mode", matchedList: "deny" }));
            continue;
        }
        const allowed = matchingRule(text, allowRules) ?? wholeAllow;
        if (allowed) {
            values.push(
                result("allow", "command matched allow list", {
                    source: "rule",
                    matchedList: "allow",
                    matchedRule: allowed,
                }),
            );
            continue;
        }
        if (strict && (config.mode === "auto" || MANUAL_SAFE.test(text))) {
            values.push(
                result("allow", "recognized read-only command", {
                    source: "mode",
                    risk: "readOnly",
                }),
            );
            continue;
        }
        if (config.mode !== "auto" && (node.redirects || (risk.risk === "readOnly" && !strict))) {
            values.push(
                result("ask", "read-only command has unsafe arguments", { source: "mode" }),
            );
            continue;
        }
        values.push(
            result(config.mode === "auto" ? "allow" : "ask", risk.reason, { source: "mode" }),
        );
    }
    if (!parsed.complete || !parsed.nodes.length)
        values.push({
            behavior: readOnly ? "deny" : "ask",
            risk: "workspaceWrite",
            reason: parsed.reason ?? "command could not be parsed",
        });
    return aggregate(values);
}

export function evaluateCommand(
    command: string,
    config: CommandPermissionConfig,
    context?: CommandEvaluationContext,
): CommandEvaluation {
    // Preserve the hard privilege boundary even when the parser marks an
    // enclosing substitution or unsupported construct as incomplete.
    const privilege = PRIVILEGE_ESCAPE.find(([pattern]) => pattern.test(command));
    if (privilege)
        return {
            behavior: "deny",
            risk: "privilegeEscape",
            reason: privilege[1],
            triggeringCommand: command,
        };
    return evaluateParsed(command, config, context);
}
export function evaluateReadOnlyCommand(
    command: string,
    context?: CommandEvaluationContext,
): CommandEvaluation {
    return evaluateParsed(command, { mode: "ask", allow: [], deny: [] }, context, true);
}

/** IM keeps its narrower channel capability boundary and shares AST semantics. */
export function evaluateCommandForImWorkspace(
    command: string,
    config: CommandPermissionConfig,
    policy: ImCommandPolicy,
    context?: CommandEvaluationContext,
): CommandEvaluation {
    const base = evaluateCommand(command, config, context);
    if (base.behavior === "deny") return base;
    const parsed = parseShellCommand(command, context?.language);
    const denied =
        matchingRule(command, policy.deny ?? [], true) ??
        parsed.nodes
            .map((node) => matchingRule(canonical(node), policy.deny ?? [], true))
            .find(Boolean);
    if (denied)
        return {
            ...base,
            behavior: "deny",
            source: "channel",
            reason: "denied by channel rule",
            matchedList: "deny",
            matchedRule: denied,
        };
    // Checked before the deny-list return: built-in denylist hits carry
    // matchedList "deny", and an auto chat has no one to answer the prompt.
    if (
        policy.mode !== "ask" &&
        (base.risk === "destructive" || base.risk === "externalSideEffect")
    )
        return { ...base, behavior: "deny", source: "channel" };
    if (base.matchedList === "deny" || !parsed.complete) return base;
    if (policy.mode === "ask") {
        // IM's ask channel has no implicit safe-command bypass: only an
        // explicit allow rule or a caller-provided session/global rule can
        // skip its approval prompt.
        return base.source === "mode" && base.risk === "readOnly"
            ? { ...base, behavior: "ask", reason: "interactive channel approval required" }
            : base;
    }
    if (policy.allow) {
        if (!parsed.nodes.every((node) => matchingRule(canonical(node), policy.allow ?? [])))
            return {
                ...base,
                behavior: "deny",
                source: "channel",
                reason: "command not allowed by channel allow list",
            };
        const channel = evaluateCommand(
            command,
            { ...config, allow: policy.allow, rules: undefined, mode: "ask" },
            context,
        );
        return { ...channel, source: "channel" };
    }
    // An unconstrained global auto mode must not silently widen an IM channel.
    const constrained = evaluateCommand(command, { ...config, mode: "ask" }, context);
    const strict =
        parsed.complete &&
        parsed.nodes.length > 0 &&
        parsed.nodes.every(
            (node) =>
                node.kind === "command" && !node.redirects && isStrictReadOnly(canonical(node)),
        );
    return strict
        ? {
              ...constrained,
              behavior: "allow",
              source: "channel",
              reason: "recognized read-only command",
          }
        : constrained;
}
