/** Bounded, asynchronous Git discovery. Git facts never establish Taco resource ownership. */
import { execFile } from "node:child_process";
import { appendFile, lstat, mkdir, readFile, realpath, rmdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type {
    GitFileChange,
    GitInspectResult,
    GitRepositoryInfo,
    GitWorktreeInfo,
    WorktreeBase,
    WorktreeCreateResult,
    WorktreeListResult,
    WorktreeRemoveResult,
} from "@taco-ai/protocol";
import { HIDDEN_WINDOWS_SPAWN } from "../lib/hiddenWindowsSpawn.ts";
import { gitDirectoryIdentity } from "../workspace/gitIdentity.ts";
import {
    WorktreeLockError,
    withWorktreeGitCommand,
    withWorktreeMutationLock,
} from "../workspace/worktreeLock.ts";
import {
    assertWorktreeStorage,
    isSafeWorktreeName,
    type ManagedWorktreeRecord,
    WorktreeMetadataStore,
} from "../workspace/worktreeMetadata.ts";
import { gitArguments, gitEnvironment } from "./gitProcess.ts";

const exec = promisify(execFile);
const COMMAND_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 10_000;
const worktreeMutations = new Map<string, Promise<unknown>>();
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

async function git(cwd: string, args: string[], signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const { stdout } = await withWorktreeGitCommand(() =>
        exec("git", gitArguments(cwd, args), {
            timeout: COMMAND_TIMEOUT_MS,
            signal,
            maxBuffer: 16 * 1024 * 1024,
            env: gitEnvironment(),
            encoding: "utf8",
            ...HIDDEN_WINDOWS_SPAWN,
        }),
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

async function checkoutBacklink(gitDir: string): Promise<string> {
    const pointer = outputLine(await readFile(join(gitDir, "gitdir"), "utf8"));
    return resolve(gitDir, pointer);
}

/** Find the main checkout from Git inventory, then verify both ends against actual Git metadata. */
async function mainCheckout(repository: GitRepositoryInfo, signal: AbortSignal): Promise<string> {
    if (repository.isBare || !repository.checkoutRoot)
        throw new GitServiceError("command_failed", "Project checkout is unavailable");
    if (repository.gitDir === repository.commonDir) return realpath(repository.checkoutRoot);
    if (dirname(repository.gitDir) !== join(repository.commonDir, "worktrees"))
        throw new GitServiceError("command_failed", "Linked worktree metadata is invalid");
    const listing = await listGitWorktrees(repository.checkoutRoot, { signal });
    if (listing.status !== "repository")
        throw new GitServiceError("command_failed", "Project checkout is unavailable");
    const main = listing.worktrees[0];
    if (!main || main.bare || main.prunable)
        throw new GitServiceError("command_failed", "Main checkout is unavailable");
    let mainPath = main.path;
    if (resolve(mainPath) === repository.commonDir) {
        try {
            const configured = outputLine(
                await git(repository.checkoutRoot, ["config", "--path", "core.worktree"], signal),
            );
            mainPath = resolve(repository.commonDir, configured);
        } catch (error) {
            // Git omits a separate checkout's location; only verified Taco provenance can supply it.
            const candidate = dirname(dirname(dirname(repository.checkoutRoot)));
            const tree = listing.worktrees.find((tree) => tree.path === repository.checkoutRoot);
            let owned = false;
            if ((error as { code?: number }).code === 1 && tree) {
                try {
                    const path = managedPath(candidate, repository.checkoutRoot);
                    const record = await new WorktreeMetadataStore(candidate).get(path);
                    owned =
                        !!record &&
                        (await matchesOwnership(record, tree, repository, candidate, signal));
                } catch {
                    owned = false;
                }
            }
            if (!owned)
                throw new GitServiceError(
                    "command_failed",
                    "Separate Git directory has no verified main checkout",
                );
            mainPath = candidate;
        }
    }
    let verified: GitRepositoryInfo | "missing" | "not_repository";
    try {
        verified = await probe(mainPath, signal);
        const backlink = await checkoutBacklink(repository.gitDir);
        if ((await realpath(backlink)) !== (await realpath(join(repository.checkoutRoot, ".git"))))
            throw new Error("invalid backlink");
    } catch {
        throw new GitServiceError("command_failed", "Main checkout is unavailable");
    }
    if (
        typeof verified === "string" ||
        verified.isBare ||
        verified.gitDir !== repository.commonDir ||
        verified.commonDir !== repository.commonDir ||
        !verified.checkoutRoot ||
        (await realpath(verified.checkoutRoot)) !== (await realpath(mainPath))
    )
        throw new GitServiceError("command_failed", "Main checkout identity does not match");
    return realpath(mainPath);
}

async function missingPath(path: string): Promise<boolean> {
    try {
        await lstat(path);
        return false;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
        throw error;
    }
}

/** Missing checkouts recover history ownership only from verified Taco provenance. */
async function removedWorktreeProjectRoot(
    cwd: string,
    signal: AbortSignal,
): Promise<string | undefined> {
    for (let tree = resolve(cwd); dirname(tree) !== tree; tree = dirname(tree)) {
        const container = dirname(tree),
            taco = dirname(container);
        if (
            basename(container) !== "worktrees" ||
            basename(taco) !== ".taco" ||
            !isSafeWorktreeName(basename(tree))
        )
            continue;
        try {
            await lstat(dirname(taco));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
            throw error;
        }
        const projectRoot = await checkedDirectory(dirname(taco));
        await assertWorktreeStorage(projectRoot, basename(tree));
        // A missing subtree of an existing checkout cannot inherit a removed record.
        try {
            await lstat(tree);
            return undefined;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const record = await new WorktreeMetadataStore(projectRoot).get(
            join(projectRoot, ".taco", "worktrees", basename(tree)),
        );
        if (!record) return undefined;
        const repository = await probe(projectRoot, signal);
        if (
            typeof repository === "string" ||
            repository.isBare ||
            !repository.checkoutRoot ||
            (await realpath(repository.checkoutRoot)) !== record.repositoryRoot ||
            repository.gitDir !== record.commonDir ||
            repository.commonDir !== record.commonDir ||
            (await directoryIdentity(repository.commonDir)) !== record.repositoryIdentity
        )
            throw new GitServiceError(
                "command_failed",
                "Removed worktree source repository identity does not match",
            );
        return projectRoot;
    }
    return undefined;
}

/** Live linked trees and verified removed trees share the main project; ordinary paths retain identity. */
export async function resolveGitProjectRoot(cwd: string): Promise<string | undefined> {
    const signal = requestSignal();
    if (!isAbsolute(cwd))
        throw new GitServiceError(
            "invalid_path",
            "Git requires an absolute local workspace directory",
        );
    try {
        await lstat(cwd);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return (await removedWorktreeProjectRoot(cwd, signal)) ?? cwd;
    }
    const repository = await probe(cwd, signal);
    if (typeof repository === "string" || repository.gitDir === repository.commonDir) return cwd;
    return mainCheckout(repository, signal);
}

async function withWorktreeMutation<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = worktreeMutations.get(key) ?? Promise.resolve();
    const next = previous
        .catch(() => undefined)
        .then(() => withWorktreeMutationLock(key, operation));
    worktreeMutations.set(key, next);
    try {
        return await next;
    } catch (error) {
        if (error instanceof WorktreeLockError)
            throw new GitServiceError("command_failed", error.message);
        throw error;
    } finally {
        if (worktreeMutations.get(key) === next) worktreeMutations.delete(key);
    }
}

async function directoryIdentity(path: string): Promise<string> {
    try {
        return await gitDirectoryIdentity(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code) throw error;
        throw new GitServiceError("invalid_path", "Git metadata directory is unsafe");
    }
}

async function verifySource(
    cwd: string,
    source: GitRepositoryInfo,
    signal: AbortSignal,
): Promise<void> {
    const current = await probe(cwd, signal);
    if (
        typeof current === "string" ||
        current.gitDir !== source.gitDir ||
        current.commonDir !== source.commonDir
    )
        throw new GitServiceError("command_failed", "Source repository identity changed");
}

function managedPath(projectRoot: string, path: string): string {
    const absolute = resolve(path);
    if (
        !isAbsolute(path) ||
        dirname(absolute) !== join(projectRoot, ".taco", "worktrees") ||
        !isSafeWorktreeName(basename(absolute))
    )
        throw new GitServiceError(
            "invalid_path",
            "Only managed worktree directories may be removed",
        );
    return absolute;
}

async function matchesOwnership(
    record: ManagedWorktreeRecord,
    tree: GitWorktreeInfo,
    repository: GitRepositoryInfo,
    projectRoot: string,
    signal: AbortSignal,
): Promise<boolean> {
    if (
        record.state === "removed" ||
        tree.bare ||
        tree.prunable ||
        record.path !== tree.path ||
        record.repositoryRoot !== projectRoot ||
        record.commonDir !== repository.commonDir
    )
        return false;
    try {
        managedPath(projectRoot, tree.path);
        await assertWorktreeStorage(projectRoot, basename(tree.path));
        const actual = await probe(tree.path, signal);
        return (
            typeof actual !== "string" &&
            !actual.isBare &&
            actual.checkoutRoot === tree.path &&
            actual.gitDir === record.gitDir &&
            actual.commonDir === record.commonDir &&
            (await directoryIdentity(actual.commonDir)) === record.repositoryIdentity &&
            (await directoryIdentity(actual.gitDir)) === record.gitDirIdentity
        );
    } catch {
        return false;
    }
}

/**
 * Ownership evidence that survives a missing checkout.
 * Git can no longer prove the path, so the record and the source repository must.
 */
async function ownsMissingCheckout(
    record: ManagedWorktreeRecord,
    projectRoot: string,
    repository: GitRepositoryInfo,
    repositoryIdentity: string,
    listed: boolean,
): Promise<boolean> {
    if (
        record.repositoryRoot !== projectRoot ||
        record.commonDir !== repository.commonDir ||
        record.repositoryIdentity !== repositoryIdentity ||
        !(await missingPath(record.path))
    )
        return false;
    if (await missingPath(record.gitDir)) return !listed;
    try {
        return (
            (await directoryIdentity(record.gitDir)) === record.gitDirIdentity &&
            (await checkoutBacklink(record.gitDir)) === join(record.path, ".git")
        );
    } catch {
        return false;
    }
}

/** Enrich Git inventory only when both Taco ownership and current repository identity agree. */
export async function readWorktreeInventory(
    cwd: string,
): Promise<{ inventory: WorktreeListResult; records: ManagedWorktreeRecord[] }> {
    const listing = await listGitWorktrees(cwd);
    if (listing.status !== "repository") return { inventory: listing, records: [] };
    const unmanaged = () => ({
        ...listing,
        worktrees: listing.worktrees.map((tree) => ({ ...tree, managed: false })),
    });
    if (listing.repository.isBare) return { inventory: unmanaged(), records: [] };
    const sourceIdentity = await directoryIdentity(listing.repository.commonDir);
    let projectRoot: string;
    try {
        projectRoot = await mainCheckout(listing.repository, requestSignal());
    } catch (error) {
        // Ownership enrichment is optional; valid Git inventory does not require a known main checkout.
        if (error instanceof GitServiceError) return { inventory: unmanaged(), records: [] };
        throw error;
    }
    const snapshot = async (repair: boolean): ReturnType<typeof readWorktreeInventory> => {
        const signal = requestSignal();
        const current = repair ? await listGitWorktrees(cwd, { signal }) : listing;
        if (
            current.status !== "repository" ||
            (repair &&
                (current.repository.gitDir !== listing.repository.gitDir ||
                    current.repository.commonDir !== listing.repository.commonDir ||
                    (await directoryIdentity(current.repository.commonDir)) !== sourceIdentity ||
                    (await mainCheckout(current.repository, signal)) !== projectRoot))
        )
            throw new GitServiceError("command_failed", "Source repository identity changed");
        const store = new WorktreeMetadataStore(projectRoot);
        const records = await store.entries();
        if (
            records.some(
                (record) =>
                    record.commonDir !== current.repository.commonDir ||
                    record.repositoryIdentity !== sourceIdentity,
            )
        )
            throw new GitServiceError(
                "command_failed",
                "Worktree repository identity does not match Taco metadata",
            );
        const repairs: ManagedWorktreeRecord[] = [];
        for (const record of records) {
            if (
                record.state === "removing" &&
                !current.worktrees.some((tree) => tree.path === record.path) &&
                (await missingPath(record.path)) &&
                (await missingPath(record.gitDir))
            )
                repairs.push(record);
        }
        if (!repair && repairs.length > 0)
            return withWorktreeMutation(listing.repository.commonDir, () => snapshot(true));
        for (const record of repairs) await store.remove(record.path);
        const refreshed = repairs.length > 0 ? await store.entries() : records;
        const byPath = new Map(refreshed.map((record) => [record.path, record]));
        const managedRoot = join(projectRoot, ".taco", "worktrees");
        const missingOwned = (record: ManagedWorktreeRecord, listed: boolean) =>
            ownsMissingCheckout(record, projectRoot, current.repository, sourceIdentity, listed);
        const rows = await Promise.all(
            current.worktrees.map(async (tree): Promise<GitWorktreeInfo | undefined> => {
                const record = byPath.get(tree.path);
                const managed =
                    !!record &&
                    (await matchesOwnership(record, tree, current.repository, projectRoot, signal));
                const orphaned =
                    !managed &&
                    dirname(tree.path) === managedRoot &&
                    isSafeWorktreeName(basename(tree.path));
                const missing = orphaned && record && (await missingOwned(record, true));
                if (missing && record.state === "removed" && tree.prunable) return undefined;
                return {
                    ...tree,
                    managed,
                    ...(orphaned ? { orphaned: true } : {}),
                    ...(missing && record.state !== "removed" ? { stale: true } : {}),
                };
            }),
        );
        const worktrees = rows.filter((tree): tree is GitWorktreeInfo => tree !== undefined);
        const listed = new Set(current.worktrees.map((tree) => tree.path));
        for (const record of refreshed) {
            if (record.state === "removed" || listed.has(record.path)) continue;
            // Git can prune a missing checkout; the ownership record still needs attention.
            worktrees.push({
                path: record.path,
                headOid: null,
                branch: null,
                detached: false,
                bare: false,
                locked: false,
                prunable: true,
                managed: false,
                orphaned: true,
                ...((await missingOwned(record, false)) ? { stale: true } : {}),
            });
        }
        return { inventory: { ...current, projectRoot, worktrees }, records: refreshed };
    };
    return snapshot(false);
}

export async function listManagedGitWorktrees(cwd: string): Promise<WorktreeListResult> {
    return (await readWorktreeInventory(cwd)).inventory;
}

async function excludeManagedContainer(
    projectRoot: string,
    commonDir: string,
    signal: AbortSignal,
): Promise<void> {
    try {
        await git(projectRoot, ["check-ignore", "--quiet", "--", ".taco/worktrees/"], signal);
        return;
    } catch (error) {
        if ((error as { code?: number }).code !== 1) throw error;
    }
    const info = join(commonDir, "info"),
        file = join(info, "exclude");
    for (const path of [info, file]) {
        try {
            const entry = await lstat(path);
            if (entry.isSymbolicLink() || (path === info ? !entry.isDirectory() : !entry.isFile()))
                throw new GitServiceError("invalid_path", "Git exclude storage is unsafe");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
    }
    await mkdir(info, { recursive: true });
    await appendFile(file, "\n/.taco/worktrees/\n", "utf8");
    await git(projectRoot, ["check-ignore", "--quiet", "--", ".taco/worktrees/"], signal);
}

async function rejectTrackedContainer(
    cwd: string,
    oid: string,
    signal: AbortSignal,
): Promise<void> {
    const files = await git(
        cwd,
        ["ls-tree", "-r", "--name-only", "-z", oid, "--", ".taco"],
        signal,
    );
    if (
        files
            .split("\0")
            .some(
                (file) =>
                    file === ".taco" ||
                    file === ".taco/worktrees" ||
                    file.startsWith(".taco/worktrees/"),
            )
    )
        throw new GitServiceError(
            "command_failed",
            "The managed worktree container is tracked in Git",
        );
}

async function assertClean(path: string, signal: AbortSignal): Promise<void> {
    // Status trusts these index flags and can hide real edits that worktree remove would delete.
    const tracked = await git(path, ["ls-files", "-v", "-z"], signal);
    if (tracked.split("\0").some((entry) => /^[a-zS] /.test(entry)))
        throw new GitServiceError(
            "command_failed",
            "Worktree has assume-unchanged or skip-worktree index flags; clear them and preserve local changes first",
        );
    const status = await git(
        path,
        [
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--ignored=matching",
            "--ignore-submodules=none",
        ],
        signal,
    );
    if (status)
        throw new GitServiceError(
            "command_failed",
            "Worktree contains local changes or ignored files; preserve them first",
        );
}

export async function createGitWorktree(
    cwd: string,
    name: string,
    base: WorktreeBase = "head",
): Promise<WorktreeCreateResult & { projectRoot: string }> {
    if (!isSafeWorktreeName(name))
        throw new GitServiceError("invalid_path", "Invalid worktree name");
    if (base !== "head" && base !== "default")
        throw new GitServiceError("invalid_path", "Invalid worktree base");
    const source = await probe(cwd, requestSignal());
    if (typeof source === "string" || source.isBare || !source.headOid)
        throw new GitServiceError(
            "command_failed",
            "A worktree requires a repository with a commit",
        );
    const sourceIdentity = await directoryIdentity(source.commonDir);
    const sourceHead = source.headOid;
    return withWorktreeMutation(source.commonDir, async () => {
        // The queue wait is outside the operation's deadline.
        const signal = requestSignal();
        await verifySource(cwd, source, signal);
        if ((await directoryIdentity(source.commonDir)) !== sourceIdentity)
            throw new GitServiceError("command_failed", "Source repository identity changed");
        const projectRoot = await mainCheckout(source, signal);
        const root = join(projectRoot, ".taco", "worktrees"),
            path = join(root, name);
        const branch = `worktree/${name}`,
            ref = `refs/heads/${branch}`;
        const store = new WorktreeMetadataStore(projectRoot);
        await assertWorktreeStorage(projectRoot, name);
        const previous = await store.get(path);
        if (
            previous &&
            (previous.commonDir !== source.commonDir ||
                previous.repositoryIdentity !== sourceIdentity ||
                (previous.state !== "removed" &&
                    (!(await missingPath(path)) || !(await missingPath(previous.gitDir)))))
        )
            throw new GitServiceError(
                "command_failed",
                "Worktree metadata already exists or its repository identity changed",
            );
        let oid = sourceHead;
        if (base === "default") {
            try {
                const target = outputLine(
                    await git(cwd, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], signal),
                );
                if (!target.startsWith("refs/remotes/origin/"))
                    throw new Error("invalid default ref");
                oid = outputLine(
                    await git(cwd, ["rev-parse", "--verify", `${target}^{commit}`], signal),
                );
            } catch {
                throw new GitServiceError(
                    "command_failed",
                    "The repository has no local default-branch reference",
                );
            }
        }
        await rejectTrackedContainer(cwd, oid, signal);
        // Also reject a tracked container in the main index even if the selected base is clean.
        const tracked = await git(projectRoot, ["ls-files", "-z", "--", ".taco"], signal);
        if (
            tracked
                .split("\0")
                .some(
                    (file) =>
                        file === ".taco" ||
                        file === ".taco/worktrees" ||
                        file.startsWith(".taco/worktrees/"),
                )
        )
            throw new GitServiceError(
                "command_failed",
                "The managed worktree container is tracked in Git",
            );
        await excludeManagedContainer(projectRoot, source.commonDir, signal);
        await mkdir(root, { recursive: true });
        await assertWorktreeStorage(projectRoot, name);
        let reservation: string | undefined;
        let branchCreated = false,
            created: GitRepositoryInfo | undefined;
        let createdIdentity: string | undefined;
        try {
            // Exclusive mkdir and compare-and-swap ref creation distinguish our artifacts from existing ones.
            await mkdir(path);
            reservation = await directoryIdentity(path);
            await git(projectRoot, ["update-ref", ref, oid, "0".repeat(oid.length)], signal);
            branchCreated = true;
            await git(projectRoot, ["worktree", "add", "--", path, branch], signal);
            const actual = await probe(path, signal);
            if (
                typeof actual === "string" ||
                actual.commonDir !== source.commonDir ||
                actual.gitDir === source.commonDir ||
                actual.branch !== branch
            )
                throw new Error("Created worktree identity does not match");
            created = actual;
            createdIdentity = await directoryIdentity(actual.gitDir);
            const now = new Date().toISOString();
            // Replace missing provenance only after Git accepted the exclusive path and branch.
            await store.markManaged(
                {
                    path,
                    branch,
                    managed: true,
                    repositoryRoot: projectRoot,
                    commonDir: source.commonDir,
                    repositoryIdentity: sourceIdentity,
                    gitDir: actual.gitDir,
                    gitDirIdentity: createdIdentity,
                    createdAt: now,
                    lastSeenAt: now,
                },
                previous?.gitDirIdentity,
            );
            return { path, branch, headOid: actual.headOid, managed: true, projectRoot };
        } catch {
            const cleanup = requestSignal();
            let removed = false;
            if (reservation && branchCreated) {
                try {
                    await assertWorktreeStorage(projectRoot, name);
                    const actual = await probe(path, cleanup);
                    if ((await directoryIdentity(path)) !== reservation)
                        throw new Error("Worktree path changed");
                    if (
                        typeof actual !== "string" &&
                        actual.commonDir === source.commonDir &&
                        actual.branch === branch &&
                        actual.gitDir !== source.commonDir &&
                        (!created ||
                            (created.gitDir === actual.gitDir &&
                                (await directoryIdentity(actual.gitDir)) === createdIdentity))
                    ) {
                        await assertClean(path, cleanup);
                        await git(projectRoot, ["worktree", "remove", "--", path], cleanup);
                        removed = true;
                    }
                } catch {
                    // A failed checkout or local data must never justify recursive force removal.
                }
            }
            if (reservation) {
                try {
                    await assertWorktreeStorage(projectRoot, name);
                    if ((await directoryIdentity(path)) === reservation) await rmdir(path);
                } catch {
                    // Preserve any changed or nonempty path.
                }
            }
            if (branchCreated) {
                const listing = await listGitWorktrees(projectRoot).catch(() => undefined);
                if (
                    listing?.status === "repository" &&
                    !listing.worktrees.some((tree) => tree.branch === branch) &&
                    (removed || !created)
                )
                    await git(projectRoot, ["update-ref", "-d", ref, oid], cleanup).catch(
                        () => undefined,
                    );
            }
            throw new GitServiceError(
                "command_failed",
                "Worktree creation or metadata persistence failed; any local data was preserved",
            );
        }
    });
}

export async function removeGitWorktree(
    cwd: string,
    path: string,
    options?: {
        beforeRemove?: () => Promise<void>;
        expectedGitDirIdentity?: string;
        forgetMissing?: boolean;
    },
): Promise<WorktreeRemoveResult> {
    const source = await probe(cwd, requestSignal());
    if (typeof source === "string" || source.isBare)
        throw new GitServiceError("command_failed", "Project checkout is unavailable");
    const sourceIdentity = await directoryIdentity(source.commonDir);
    return withWorktreeMutation(source.commonDir, async () => {
        const signal = requestSignal();
        await verifySource(cwd, source, signal);
        if ((await directoryIdentity(source.commonDir)) !== sourceIdentity)
            throw new GitServiceError("command_failed", "Source repository identity changed");
        const projectRoot = await mainCheckout(source, signal);
        const target = managedPath(projectRoot, path);
        await assertWorktreeStorage(projectRoot, basename(target));
        const store = new WorktreeMetadataStore(projectRoot);
        const record = await store.get(target);
        if (!record)
            throw new GitServiceError(
                "command_failed",
                "Worktree has no verified Taco ownership metadata",
            );
        if (
            options?.expectedGitDirIdentity !== undefined &&
            record.gitDirIdentity !== options.expectedGitDirIdentity
        )
            throw new GitServiceError("command_failed", "Selected worktree identity changed");
        const listing = await listGitWorktrees(cwd, { signal });
        const entry =
            listing.status === "repository"
                ? listing.worktrees.find((tree) => tree.path === target)
                : undefined;
        if (
            !entry &&
            (record.state === "removing" || record.state === "removed") &&
            record.commonDir === source.commonDir &&
            record.repositoryIdentity === sourceIdentity
        ) {
            // Only a persisted deletion intent can finish without a live checkout to verify.
            if (
                (await missingPath(target)) &&
                (record.state === "removed" || (await missingPath(record.gitDir)))
            ) {
                if (record.state !== "removed") await store.remove(target);
                return {
                    path: target,
                    branch:
                        record.removalBranch === undefined ? record.branch : record.removalBranch,
                    removed: true,
                };
            }
        }
        if (
            options?.forgetMissing &&
            !entry?.bare &&
            !entry?.locked &&
            (await ownsMissingCheckout(record, projectRoot, source, sourceIdentity, !!entry))
        ) {
            // The checkout was deleted outside Taco; only its verified record can be forgotten.
            const branch = entry
                ? entry.branch
                : record.removalBranch === undefined
                  ? record.branch
                  : record.removalBranch;
            if (record.state !== "removed") {
                await options?.beforeRemove?.();
                await store.beginRemove(target, branch);
                await store.remove(target);
            }
            return { path: target, branch, removed: true };
        }
        if (options?.forgetMissing)
            throw new GitServiceError(
                "command_failed",
                "The missing worktree record can no longer be forgotten",
            );
        if (!entry || entry.locked || entry.bare || entry.prunable)
            throw new GitServiceError("command_failed", "Worktree is unavailable or locked");
        if (options?.expectedGitDirIdentity !== undefined && entry.detached)
            throw new GitServiceError(
                "command_failed",
                "Cleanup cannot remove a detached worktree",
            );
        if (!(await matchesOwnership(record, entry, source, projectRoot, signal)))
            throw new GitServiceError(
                "command_failed",
                "Worktree repository identity does not match Taco metadata",
            );
        await assertClean(target, signal);
        await store.beginRemove(target, entry.branch);
        await options?.beforeRemove?.();
        try {
            await git(projectRoot, ["worktree", "remove", "--", target], signal);
            await store.remove(target);
        } catch {
            throw new GitServiceError(
                "command_failed",
                "Worktree removal or metadata update failed; preserve local changes first",
            );
        }
        return { path: target, branch: entry.branch, removed: true };
    });
}
