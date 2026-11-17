/** Bounded, asynchronous Git discovery. Git facts never establish Taco resource ownership. */
import { execFile } from "node:child_process";
import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type {
    GitFileChange,
    GitInspectResult,
    GitRepositoryInfo,
    GitWorktreeInfo,
    WorktreeListResult,
} from "@taco-ai/protocol";
import { HIDDEN_WINDOWS_SPAWN } from "../lib/hiddenWindowsSpawn.ts";
import { scrubbedProcessEnv } from "../runtime/models/providerKeyStore.ts";

const exec = promisify(execFile);
const COMMAND_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 10_000;
interface GitReadOptions {
    signal?: AbortSignal;
}
function requestSignal(options?: GitReadOptions): AbortSignal {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    return options?.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
}

/** Domain errors preserve a useful message without exposing arbitrary subprocess output. */
export class GitServiceError extends Error {
    constructor(
        readonly reason: "invalid_path" | "command_failed",
        message: string,
    ) {
        super(message);
    }
}

function gitEnv(): Record<string, string> {
    const env = scrubbedProcessEnv();
    // A daemon's ambient Git overrides must never redirect a workspace query or git init.
    for (const key of Object.keys(env))
        if (key.startsWith("GIT_")) Reflect.deleteProperty(env, key);
    return { ...env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
}

async function git(cwd: string, args: string[], signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const { stdout } = await exec(
        "git",
        ["--no-pager", "-c", "core.fsmonitor=false", "-C", cwd, ...args],
        {
            timeout: COMMAND_TIMEOUT_MS,
            signal,
            maxBuffer: 16 * 1024 * 1024,
            env: gitEnv(),
            encoding: "utf8",
            ...HIDDEN_WINDOWS_SPAWN,
        },
    );
    return stdout;
}

function outputLine(value: string): string {
    return value.replace(process.platform === "win32" ? /\r?\n$/ : /\n$/, "");
}

function unavailableGit(error: unknown): boolean {
    const e = error as { code?: unknown; stderr?: string };
    return (
        e.code === "ENOENT" ||
        /xcrun: error:.*(?:invalid active developer path|missing xcrun)|xcode-select: note: No developer tools were found/.test(
            e.stderr ?? "",
        )
    );
}

async function checkedDirectory(cwd: string): Promise<string> {
    if (!isAbsolute(cwd))
        throw new GitServiceError(
            "invalid_path",
            "Git requires an absolute local workspace directory",
        );
    try {
        const path = await realpath(cwd);
        if (!(await stat(path)).isDirectory()) throw new Error("not directory");
        return path;
    } catch {
        throw new GitServiceError("invalid_path", "The workspace directory is unavailable");
    }
}

/** An invalid .git marker (or damaged bare layout) must not be reinitialized. */
async function hasGitMetadata(path: string): Promise<boolean> {
    async function exists(candidate: string): Promise<boolean> {
        try {
            await lstat(candidate);
            return true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
            throw error;
        }
    }
    for (let cursor = path; ; cursor = dirname(cursor)) {
        if (await exists(join(cursor, ".git"))) return true;
        if ((await exists(join(cursor, "objects"))) && (await exists(join(cursor, "refs"))))
            return true;
        if (dirname(cursor) === cursor) return false;
    }
}

async function probe(
    cwd: string,
    signal: AbortSignal,
): Promise<GitRepositoryInfo | "missing" | "not_repository"> {
    const path = await checkedDirectory(cwd);
    let gitDir: string;
    try {
        gitDir = outputLine(await git(path, ["rev-parse", "--absolute-git-dir"], signal));
    } catch (error) {
        if (unavailableGit(error)) return "missing";
        if (
            /not a git repository/.test((error as { stderr?: string }).stderr ?? "") &&
            !(await hasGitMetadata(path))
        )
            return "not_repository";
        throw new GitServiceError("command_failed", "Git could not inspect this directory");
    }
    try {
        const [commonDir, bare] = await Promise.all([
            git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal),
            git(path, ["rev-parse", "--is-bare-repository"], signal),
        ]);
        const isBare = bare.trim() === "true";
        const checkoutRoot = isBare
            ? null
            : outputLine(await git(path, ["rev-parse", "--show-toplevel"], signal));
        // A valid repository can have an unborn branch or detached HEAD.
        const [head, branch] = await Promise.all([
            git(path, ["rev-parse", "--verify", "--quiet", "HEAD"], signal).catch((error) => {
                if ((error as { code?: number }).code === 1) return "";
                throw error;
            }),
            git(path, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal).catch((error) => {
                if ((error as { code?: number }).code === 1) return "";
                throw error;
            }),
        ]);
        return {
            checkoutRoot,
            gitDir: await realpath(gitDir),
            commonDir: await realpath(outputLine(commonDir)),
            isBare,
            headOid: head.trim() || null,
            branch: branch.trimEnd() || null,
        };
    } catch {
        throw new GitServiceError("command_failed", "Git repository metadata could not be read");
    }
}

function localPath(checkoutRoot: string, cwd: string, path: string): string | undefined {
    const rel = relative(cwd, resolve(checkoutRoot, path));
    return rel &&
        rel !== ".." &&
        !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
        !isAbsolute(rel)
        ? process.platform === "win32"
            ? rel.replaceAll("\\", "/")
            : rel
        : undefined;
}

/** porcelain -z keeps spaces, tabs, newlines and non-ASCII names literal. */
function changesFromPorcelain(output: string, checkoutRoot: string, cwd: string): GitFileChange[] {
    const records = output.split("\0");
    const changes: GitFileChange[] = [];
    for (let index = 0; index < records.length; index++) {
        const record = records[index];
        if (!record) continue;
        const x = record[0],
            y = record[1];
        const renamed = x === "R" || y === "R" || x === "C" || y === "C";
        const original = renamed ? records[++index] : undefined;
        const path = localPath(checkoutRoot, cwd, record.slice(3));
        // Renames may cross the selected subtree boundary.
        const originalPath =
            original === undefined ? undefined : localPath(checkoutRoot, cwd, original);
        if (!path) {
            if (originalPath)
                changes.push({
                    path: originalPath,
                    indexStatus: x,
                    worktreeStatus: y,
                    kind: "deleted",
                });
            continue;
        }
        const conflict =
            x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D");
        const kind = conflict
            ? "conflict"
            : x === "D" || y === "D"
              ? "deleted"
              : renamed
                ? "renamed"
                : x === "?" || x === "A" || y === "A"
                  ? "added"
                  : "modified";
        changes.push({
            path,
            ...(originalPath ? { originalPath } : {}),
            indexStatus: x,
            worktreeStatus: y,
            kind,
        });
    }
    return changes;
}

export async function inspectGit(cwd: string, options?: GitReadOptions): Promise<GitInspectResult> {
    return inspectWithSignal(cwd, requestSignal(options));
}
async function inspectWithSignal(cwd: string, signal: AbortSignal): Promise<GitInspectResult> {
    const repository = await probe(cwd, signal);
    if (typeof repository === "string") return { status: repository };
    if (repository.isBare || !repository.checkoutRoot)
        return { status: "repository", repository, changes: [] };
    try {
        const output = await git(
            repository.checkoutRoot,
            ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"],
            signal,
        );
        return {
            status: "repository",
            repository,
            changes: changesFromPorcelain(output, repository.checkoutRoot, await realpath(cwd)),
        };
    } catch {
        throw new GitServiceError("command_failed", "Git could not read working tree changes");
    }
}

export async function initializeGit(
    cwd: string,
    options?: GitReadOptions,
): Promise<GitInspectResult> {
    const signal = requestSignal(options);
    const current = await probe(cwd, signal);
    if (current !== "not_repository")
        return typeof current === "string" ? { status: current } : inspectWithSignal(cwd, signal);
    try {
        await git(await checkedDirectory(cwd), ["init"], signal);
    } catch (error) {
        if (unavailableGit(error)) return { status: "missing" };
        throw new GitServiceError("command_failed", "Git repository initialization failed");
    }
    return inspectWithSignal(cwd, signal);
}

export async function listGitWorktrees(
    cwd: string,
    options?: GitReadOptions,
): Promise<WorktreeListResult> {
    const signal = requestSignal(options);
    const repository = await probe(cwd, signal);
    if (typeof repository === "string") return { status: repository };
    try {
        const output = await git(cwd, ["worktree", "list", "--porcelain", "-z"], signal);
        const worktrees: GitWorktreeInfo[] = [];
        let current: GitWorktreeInfo | undefined;
        for (const field of output.split("\0")) {
            if (field.startsWith("worktree ")) {
                current = {
                    path: field.slice(9),
                    headOid: null,
                    branch: null,
                    detached: false,
                    bare: false,
                    locked: false,
                    prunable: false,
                };
                worktrees.push(current);
            } else if (current) {
                if (field.startsWith("HEAD "))
                    current.headOid = /^0+$/.test(field.slice(5)) ? null : field.slice(5);
                else if (field.startsWith("branch "))
                    current.branch = field.slice(7).replace(/^refs\/heads\//, "");
                else if (field === "detached") current.detached = true;
                else if (field === "bare") current.bare = true;
                else if (field === "locked" || field.startsWith("locked ")) {
                    current.locked = true;
                    if (field.length > 7) current.lockReason = field.slice(7);
                } else if (field === "prunable" || field.startsWith("prunable ")) {
                    current.prunable = true;
                    if (field.length > 9) current.pruneReason = field.slice(9);
                }
            }
        }
        return { status: "repository", repository, worktrees };
    } catch {
        throw new GitServiceError("command_failed", "Git worktrees could not be listed");
    }
}
