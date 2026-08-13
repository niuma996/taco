/**
 * Builtin git-context extension. Injects two hidden tags per LLM call when cwd
 * is a git repo: `<recent_git_commits>` and `<working_tree_changes>`, both
 * compression="pin". Returns `undefined` when not a git repo or `git` not on PATH.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ContextEvent, ContextResult } from "@earendil-works/pi-agent-core";
import { tagWrap } from "../../../tags/builder.ts";
import type { TagSpec } from "../../../tags/types.ts";
import type { BuiltinManifest } from "../../builtinContract.ts";
import type { ContextHook, WorkspaceActivator } from "../../types.ts";

const execFileAsync = promisify(execFile);

const TAG_NAME = "recent_git_commits";
const WORKING_TREE_TAG_NAME = "working_tree_changes";

const BUILTIN_NAME = "@taco/builtin-git-context";

const TAG_SPEC: TagSpec = {
    name: TAG_NAME,
    scope: "user-context",
    compression: { kind: "pin" },
    tuiVisibility: "hidden",
    parser: { kind: "xml-balanced" },
    description: "Last N commits in cwd (hash, subject, author, date, --stat summary)",
};

const WORKING_TREE_TAG_SPEC: TagSpec = {
    name: WORKING_TREE_TAG_NAME,
    scope: "user-context",
    compression: { kind: "pin" },
    tuiVisibility: "hidden",
    parser: { kind: "xml-balanced" },
    description: "Uncommitted files: staged changes, unstaged modifications, and untracked files",
};

/**
 * Guidance text prepended to every injected commits tag.
 * Lives in the context hook (not system prompt) so it stays in sync with
 * the commits — it is never stale when a new commit appears mid-session.
 */
const TAG_GUIDANCE =
    "Use this only as reference when the user's request is plausibly " +
    "related to recent changes (e.g. debugging a regression, continuing " +
    "an in-progress task, or reviewing intent). Do NOT bring it up " +
    "unprompted, do NOT reference it in summaries or commit messages, " +
    "and do NOT let it bias the main task. Treat it as low-priority background.";

/** How many recent commits to inject. */
const COMMIT_LIMIT = 5;
/** `--stat` line cap (number of files shown per commit). */
const STAT_FILE_LIMIT = 8;

interface Commit {
    readonly hash: string;
    readonly subject: string;
    readonly author: string;
    readonly date: string;
    readonly stat: string;
}

interface GitProbeResult {
    readonly ok: boolean;
    readonly reason?: string;
}

/**
 * Multi-entry probe cache keyed by cwd.
 * Each entry is cached for `CACHE_MS` to avoid hammering on every LLM call.
 * Bounded to `CACHE_MAX_SIZE` to prevent monotonic growth in long-running
 * processes with many distinct workspaces.
 */
const _probeCache = new Map<string, { ok: boolean; reason?: string; at: number }>();
const CACHE_MS = 30_000;
const CACHE_MAX_SIZE = 64;

function setProbeCache(cwd: string, value: { ok: boolean; reason?: string; at: number }): void {
    if (_probeCache.size >= CACHE_MAX_SIZE && !_probeCache.has(cwd)) {
        const oldest = _probeCache.keys().next().value;
        if (oldest !== undefined) {
            _probeCache.delete(oldest);
        }
    }
    _probeCache.set(cwd, value);
}

async function probeGit(cwd: string): Promise<GitProbeResult> {
    const cached = _probeCache.get(cwd);
    if (cached && Date.now() - cached.at < CACHE_MS) {
        return { ok: cached.ok, reason: cached.reason };
    }
    try {
        await execFileAsync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], {
            timeout: 2000,
        });
        setProbeCache(cwd, { ok: true, at: Date.now() });
        return { ok: true };
    } catch (e) {
        const reason = (e as Error).message ?? String(e);
        setProbeCache(cwd, { ok: false, reason, at: Date.now() });
        return { ok: false, reason };
    }
}

/**
 * Read the last `n` commits in `cwd`. Output format (per commit, NUL-separated):
 *   hash\x1fsubject\x1fauthor\x1fdate
 * followed by a `--stat -n ${STAT_FILE_LIMIT}` summary for each.
 */
async function readRecentCommits(cwd: string, n: number): Promise<Commit[]> {
    // --no-pager avoids spawning the pager process when stdout is non-tty.
    const fmt = ["%h%x1f%s%x1f%an%x1f%ar"];
    const out = await execFileAsync(
        "git",
        [
            "-C",
            cwd,
            "--no-pager",
            "log",
            "-n",
            String(n),
            `--pretty=format:${fmt.join("")}`,
            "--shortstat",
            `--stat=${STAT_FILE_LIMIT}`,
        ],
        { timeout: 5000, maxBuffer: 256 * 1024 },
    );
    const stdout = out.stdout.trim();
    if (!stdout) return [];
    // Each commit is: 4 NUL-separated header lines + a free-form stat paragraph,
    // separated by a blank line. We split on blank lines first, then parse each.
    const blocks = stdout.split(/\n\n+/);
    const commits: Commit[] = [];
    for (const block of blocks) {
        const lines = block.split("\n");
        const header = lines[0];
        if (!header) continue;
        const parts = header.split("\x1f");
        if (parts.length < 4) continue;
        const [hash, subject, author, date] = parts;
        if (!hash) continue;
        const stat = lines.slice(1).join("\n").trim();
        commits.push({
            hash,
            subject: subject ?? "",
            author: author ?? "",
            date: date ?? "",
            stat,
        });
    }
    return commits;
}

function formatCommits(commits: ReadonlyArray<Commit>): string {
    if (commits.length === 0) {
        return "(no commits)";
    }
    const items = commits.map((c) => {
        const stat = c.stat ? `\n${c.stat}` : "";
        return `• ${c.hash} — ${c.subject}\n  by ${c.author}, ${c.date}${stat}`;
    });
    return `⚠️ ${TAG_GUIDANCE}\n\n${items.join("\n\n")}`;
}

/**
 * Uncommitted files in a workspace.
 * `staged` — changes in the index; `unstaged` — modified files not yet staged;
 * `untracked` — files git knows nothing about.
 */
interface UncommittedFiles {
    readonly staged: ReadonlyArray<string>;
    readonly unstaged: ReadonlyArray<string>;
    readonly untracked: ReadonlyArray<string>;
}

/**
 * Read uncommitted files in `cwd` — staged, unstaged, and untracked.
 * Always returns a non-null result (empty arrays when nothing is uncommitted).
 * Errors are silently swallowed for graceful degradation.
 *
 * Format: staged "A  path", unstaged " M path", untracked "?? path".
 * All three calls run in parallel to minimize latency.
 */
export async function readUncommittedFiles(cwd: string): Promise<UncommittedFiles> {
    const run = (args: string[]): Promise<{ code: number; stdout: string }> =>
        execFileAsync("git", ["-C", cwd, ...args], { timeout: 3000, maxBuffer: 64 * 1024 })
            .then((out) => ({ code: 0, stdout: out.stdout }))
            .catch((e: unknown) => {
                const err = e as { code?: number; stdout?: string };
                return { code: err.code ?? 128, stdout: err.stdout ?? "" };
            });

    const results = await Promise.all([
        run(["diff", "--cached", "--name-status"]),
        run(["diff", "--name-status"]),
        run(["ls-files", "--others", "--exclude-standard"]),
    ]);

    const parseStatus = (stdout: string): ReadonlyArray<string> =>
        stdout
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l.length > 0);

    const [stagedResult, unstagedResult, untrackedResult] = results;
    return {
        staged: stagedResult.code === 0 ? parseStatus(stagedResult.stdout) : [],
        unstaged: unstagedResult.code === 0 ? parseStatus(unstagedResult.stdout) : [],
        untracked: untrackedResult.code === 0 ? parseStatus(untrackedResult.stdout) : [],
    };
}

function formatUncommittedFiles(files: UncommittedFiles): string | undefined {
    const { staged, unstaged, untracked } = files;
    const total = staged.length + unstaged.length + untracked.length;
    if (total === 0) return undefined;

    const lines: string[] = [];
    if (staged.length > 0) {
        lines.push(`${staged.length} file${staged.length === 1 ? "" : "s"} staged:`);
        for (const f of staged.slice(0, 50)) lines.push(`  ${f}`);
        if (staged.length > 50) lines.push(`  ... and ${staged.length - 50} more`);
    }
    if (unstaged.length > 0) {
        lines.push(`${unstaged.length} unstaged modification${unstaged.length === 1 ? "" : "s"}:`);
        for (const f of unstaged.slice(0, 50)) lines.push(`  ${f}`);
        if (unstaged.length > 50) lines.push(`  ... and ${unstaged.length - 50} more`);
    }
    if (untracked.length > 0) {
        lines.push(`${untracked.length} untracked file${untracked.length === 1 ? "" : "s"}:`);
        for (const f of untracked.slice(0, 50)) lines.push(`  ${f}`);
        if (untracked.length > 50) lines.push(`  ... and ${untracked.length - 50} more`);
    }
    return lines.join("\n");
}

/**
 * Context hook factory bound to a specific `cwd`.
 *
 * Lazily probes whether `cwd` is a git repo on first invocation and caches
 * the result per-cwd.  Returns `undefined` when cwd is unset or git is unavailable.
 */
export function buildGitContextHook(cwd: string): ContextHook {
    let probed = false;
    let probeResult: GitProbeResult | undefined;

    return async (event: ContextEvent): Promise<ContextResult | undefined> => {
        if (!probed) {
            probeResult = await probeGit(cwd);
            probed = true;
        }
        if (!probeResult?.ok) return undefined;

        let commits: Commit[];
        try {
            commits = await readRecentCommits(cwd, COMMIT_LIMIT);
        } catch {
            // git command failed at runtime (race, corrupt repo, etc.) — silently skip
            return undefined;
        }

        const uncommittedFiles = await readUncommittedFiles(cwd);
        const commitsTag =
            commits.length > 0 ? tagWrap(TAG_NAME, formatCommits(commits)) : undefined;
        const uncommittedText = formatUncommittedFiles(uncommittedFiles);
        const uncommittedTag = uncommittedText
            ? tagWrap(WORKING_TREE_TAG_NAME, uncommittedText)
            : undefined;

        if (!commitsTag && !uncommittedTag) return undefined;

        const messages = [
            ...(commitsTag
                ? [{ role: "user" as const, content: commitsTag, timestamp: Date.now() }]
                : []),
            ...(uncommittedTag
                ? [{ role: "user" as const, content: uncommittedTag, timestamp: Date.now() }]
                : []),
            ...event.messages,
        ];
        return { messages };
    };
}

/** Get the tag spec — exposed so the loader can register it. */
export function getRecentGitCommitsTagSpec(): TagSpec {
    return TAG_SPEC;
}

/** Get the working-tree tag spec — exposed so the loader can register it. */
export function getWorkingTreeChangesTagSpec(): TagSpec {
    return WORKING_TREE_TAG_SPEC;
}

/**
 * Workspace activator for git-context.
 *
 * Probes `ctx.cwd` asynchronously; if it is a git repo returns a context hook
 * bound to that cwd plus the system-prompt guidance.  If not a git repo (or git
 * is unavailable) returns `undefined` — no contribution for this workspace.
 */
export function buildGitContextActivator(): WorkspaceActivator {
    return async (ctx) => {
        const probe = await probeGit(ctx.cwd);
        if (!probe.ok) return undefined;
        const hook = buildGitContextHook(ctx.cwd);
        return { contextHooks: [hook] };
    };
}

/** Builtin manifest — self-describes metadata, tag spec, and workspace activator. */
export const manifest: BuiltinManifest = {
    name: BUILTIN_NAME,
    description:
        "Injects <recent_git_commits> (last N commits: hash, subject, author, date, --stat) and <working_tree_changes> (staged, unstaged, untracked files) as hidden tags with inline usage guidance. Silently no-ops on non-git repos or when git is unavailable.",
    whenToUse:
        "Built-in. Disable via `disabledExtensions` in ~/.taco/taco.json if you don't want git context surfaced to the model.",
    register: (registry) => {
        registry.addExtensionTag(BUILTIN_NAME, TAG_SPEC.name, TAG_SPEC);
        registry.addExtensionTag(BUILTIN_NAME, WORKING_TREE_TAG_SPEC.name, WORKING_TREE_TAG_SPEC);
    },
    activator: buildGitContextActivator,
};
