/** Taco ownership is recorded separately from Git's worktree inventory. */
import { lstat, mkdir, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { writeJsonAtomic } from "../store/atomicFile.ts";

export interface ManagedWorktreeRecord {
    readonly path: string;
    readonly branch: string;
    readonly managed: true;
    readonly state?: "removing" | "removed";
    readonly removalBranch?: string | null;
    readonly repositoryRoot: string;
    readonly commonDir: string;
    readonly repositoryIdentity: string;
    readonly gitDir: string;
    readonly gitDirIdentity: string;
    readonly createdAt: string;
    readonly lastSeenAt: string;
}

export function isSafeWorktreeName(name: string): boolean {
    return (
        /^[a-z0-9][a-z0-9-]{0,79}$/.test(name) &&
        !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(name)
    );
}

/** Reject symlinks at every component below the verified main checkout. */
export async function assertWorktreeStorage(projectRoot: string, leaf?: string): Promise<void> {
    const paths = [
        projectRoot,
        join(projectRoot, ".taco"),
        join(projectRoot, ".taco", "worktrees"),
    ];
    if (leaf) paths.push(join(projectRoot, ".taco", "worktrees", leaf));
    for (const path of paths) {
        try {
            const entry = await lstat(path);
            if (entry.isSymbolicLink() || (path !== paths.at(-1) && !entry.isDirectory()))
                throw new Error("Unsafe worktree metadata storage");
            if (!leaf && !entry.isDirectory()) throw new Error("Unsafe worktree metadata storage");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
    }
}

function invalid(): never {
    throw new Error("Invalid worktree metadata");
}

function absolutePath(value: unknown): value is string {
    return typeof value === "string" && isAbsolute(value) && resolve(value) === value;
}

function identity(value: unknown): value is string {
    return typeof value === "string" && /^\d+:\d+:[\d.]+$/.test(value);
}

function timestamp(value: unknown): value is string {
    return (
        typeof value === "string" &&
        Number.isFinite(Date.parse(value)) &&
        new Date(value).toISOString() === value
    );
}

export class WorktreeMetadataStore {
    private readonly projectRoot: string;
    private readonly root: string;
    private readonly file: string;

    constructor(projectRoot: string) {
        this.projectRoot = resolve(projectRoot);
        this.root = join(this.projectRoot, ".taco", "worktrees");
        this.file = join(this.root, "index.json");
    }

    async get(path: string): Promise<ManagedWorktreeRecord | undefined> {
        return (await this.read()).find((entry) => entry.path === resolve(path));
    }

    async markManaged(entry: ManagedWorktreeRecord): Promise<void> {
        this.validate(entry);
        const entries = await this.read();
        const previous = entries.find((item) => item.path === entry.path);
        if (
            previous &&
            previous.state !== "removed" &&
            (previous.gitDirIdentity !== entry.gitDirIdentity || previous.branch !== entry.branch)
        )
            invalid();
        const next = entries.filter((item) => item.path !== entry.path);
        next.push(entry);
        this.validateEntries(next);
        await this.write(next);
    }

    async remove(path: string): Promise<void> {
        const entries = await this.read();
        const entry = entries.find((item) => item.path === resolve(path));
        if (!entry) invalid();
        await this.write(
            entries.map((item) =>
                item === entry
                    ? { ...item, state: "removed", lastSeenAt: new Date().toISOString() }
                    : item,
            ),
        );
    }

    async beginRemove(path: string, branch: string | null): Promise<void> {
        const entries = await this.read();
        const entry = entries.find((item) => item.path === resolve(path));
        if (!entry || entry.state === "removed") invalid();
        await this.write(
            entries.map((item) =>
                item === entry
                    ? {
                          ...item,
                          state: "removing",
                          removalBranch: branch,
                          lastSeenAt: new Date().toISOString(),
                      }
                    : item,
            ),
        );
    }

    private validate(value: unknown): asserts value is ManagedWorktreeRecord {
        if (!value || typeof value !== "object") invalid();
        const entry = value as Partial<ManagedWorktreeRecord>;
        if (
            !absolutePath(entry.path) ||
            dirname(entry.path) !== this.root ||
            !isSafeWorktreeName(basename(entry.path)) ||
            entry.branch !== `worktree/${basename(entry.path)}` ||
            entry.managed !== true ||
            (entry.state !== undefined &&
                entry.state !== "removing" &&
                entry.state !== "removed") ||
            (entry.removalBranch !== undefined &&
                entry.removalBranch !== null &&
                typeof entry.removalBranch !== "string") ||
            (entry.state === "removing" && entry.removalBranch === undefined) ||
            entry.repositoryRoot !== this.projectRoot ||
            !absolutePath(entry.commonDir) ||
            !absolutePath(entry.gitDir) ||
            dirname(dirname(entry.gitDir)) !== entry.commonDir ||
            basename(dirname(entry.gitDir)) !== "worktrees" ||
            !identity(entry.repositoryIdentity) ||
            !identity(entry.gitDirIdentity) ||
            !timestamp(entry.createdAt) ||
            !timestamp(entry.lastSeenAt) ||
            entry.lastSeenAt < entry.createdAt
        )
            invalid();
    }

    private validateEntries(entries: unknown[]): asserts entries is ManagedWorktreeRecord[] {
        const paths = new Set<string>(),
            branches = new Set<string>(),
            gitDirs = new Set<string>();
        let repository: string | undefined;
        for (const value of entries) {
            this.validate(value);
            const key = `${value.commonDir}\0${value.repositoryIdentity}`;
            if (
                paths.has(value.path) ||
                branches.has(value.branch) ||
                (value.state !== "removed" && gitDirs.has(value.gitDir)) ||
                (repository !== undefined && repository !== key)
            )
                invalid();
            paths.add(value.path);
            branches.add(value.branch);
            if (value.state !== "removed") gitDirs.add(value.gitDir);
            repository = key;
        }
    }

    private async write(entries: ManagedWorktreeRecord[]): Promise<void> {
        await assertWorktreeStorage(this.projectRoot, "index.json");
        await mkdir(this.root, { recursive: true });
        await assertWorktreeStorage(this.projectRoot, "index.json");
        await writeJsonAtomic(this.file, { version: 1, worktrees: entries }, { indent: 2 });
    }

    private async read(): Promise<ManagedWorktreeRecord[]> {
        await assertWorktreeStorage(this.projectRoot, "index.json");
        let body: string;
        try {
            body = await readFile(this.file, "utf8");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
            throw error;
        }
        const document: unknown = JSON.parse(body);
        if (
            !document ||
            typeof document !== "object" ||
            !("version" in document) ||
            document.version !== 1 ||
            !("worktrees" in document) ||
            !Array.isArray(document.worktrees)
        )
            invalid();
        this.validateEntries(document.worktrees);
        return document.worktrees;
    }
}
