/**
 * Persistent store for workspace directory associations.
 *
 * A workspace's tool permissions are rooted at a set of directories: its own
 * root (the cwd) plus any associated directories the user granted. This
 * store holds the associated sets.
 *
 * Lives at `$TACO_HOME/workspace-associations.json` — a sidecar-owned file,
 * not a desktop one. Every client (desktop, CLI, the scheduler) reads the
 * same sets, and a change made in one is visible to the others.
 *
 * TWO STORAGE SCOPES, because the admin picks the granularity:
 *  - `workspace` — one workspace: a filesystem cwd, or one IM conversation
 *    (`im://<channelId>/<peerId>/<chatId>`).
 *  - `channel` — every conversation on one IM channel.
 *
 * The scopes live in separate namespaces, so a channel id that happens to
 * look like a path cannot collide with a workspace entry.
 *
 * Reads are deliberately uncached. In daemon mode one process runs several
 * SidecarServers — `imHost` owns the IM workspaces, `schedulerSidecar` owns
 * the fs ones, and each NDJSON connection gets its own — each with its own
 * WorkspaceRegistry. An in-memory cache would let one of them act on a stale
 * set after another wrote it. Reading the small file on each use costs
 * nothing next to the fs operations it guards.
 *
 * Permissions: the file holds paths, not secrets, but it lives under
 * $TACO_HOME with the rest of the user's state and is written 0600 so a
 * shared machine does not leak the directory layout.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkspaceAssociationKey, WorkspaceId } from "@taco-ai/protocol";
import { IM_CWD_PREFIX, parseImCwd } from "@taco-ai/protocol";
import { tacoHome } from "../config/tacoHome.ts";
import { restrictOwner } from "../lib/fsPermissions.ts";
import { createLogger } from "../lib/logger.ts";
import {
    checkGrantRootSafety,
    isSameOrInside,
    realpathBestEffort,
} from "../permissions/grantRootSafety.ts";

const log = createLogger("workspace:associations");

/** On-disk schema version. Bumped when the document shape changes. */
const ASSOCIATIONS_DOCUMENT_VERSION = 1;
/** A crashed writer must not leave every later association write blocked. */
const ASSOCIATIONS_LOCK_STALE_MS = 60_000;
const ASSOCIATIONS_LOCK_RETRY_MS = 10;

export interface WorkspaceAssociationsDocument {
    version?: number;
    /** Workspace-scope sets, keyed by workspace id (cwd path or `im://` URL). */
    workspaces?: Record<string, string[]>;
    /** Channel-scope sets, keyed by channel id. */
    channels?: Record<string, string[]>;
}

export function workspaceAssociationsPath(home: string = tacoHome()): string {
    return path.join(home, "workspace-associations.json");
}

/**
 * Why a candidate root was refused.
 *
 * The message reaches the desktop verbatim, so it names the offending path
 * and the rule that rejected it — the user is looking at a permission grant
 * they tried to make and need to know which constraint blocked it.
 */
export class AssociationValidationError extends Error {
    constructor(
        message: string,
        readonly path: string,
    ) {
        super(message);
        this.name = "AssociationValidationError";
    }
}

export interface AssociationStoreOptions {
    /** Overrides the document location. Tests point this at a temp dir. */
    readonly home?: string;
}

/**
 * Normalize a storage key to a stable form.
 *
 * A workspace-scope key is a filesystem path, so it is resolved — the same
 * directory reached by a different spelling must be one entry. An IM
 * workspace's key is its `im://` URL, which must not be run through
 * `path.resolve`.
 *
 * A channel-scope key is a channel id, not a path, so it is left alone.
 */
export function normalizeAssociationKey(key: WorkspaceAssociationKey): string {
    if (key.scope === "channel") return key.id;
    if (key.id.startsWith(IM_CWD_PREFIX)) return key.id;
    return path.resolve(key.id);
}

/**
 * Whether a workspace's effective association set can change when the given
 * key's set changes — the push fan-out predicate.
 *
 * Registry keys carry the client's spelling of a directory, association
 * keys the writer's; the same directory spelled differently must still fan
 * out. The wire payload keeps the caller's raw key either way — matching
 * happens here, on normalized forms.
 */
export function associationAffectsWorkspace(cwd: string, key: WorkspaceAssociationKey): boolean {
    if (key.scope === "workspace") {
        return (
            normalizeAssociationKey({ scope: "workspace", id: cwd }) ===
            normalizeAssociationKey(key)
        );
    }
    // Channel scope: only IM conversations inherit a channel's set. An fs
    // workspace's cwd is not a routing key, so it has no channel to
    // fall back to.
    if (!cwd.startsWith(IM_CWD_PREFIX)) return false;
    return parseImCwd(cwd)?.channelId === key.id;
}

/**
 * Read / write the associated-directory sets.
 *
 * The instance holds no cached state: every method reads the document from
 * disk. Writes are serialized through a promise chain so two concurrent
 * `set` calls cannot interleave their read-modify-write.
 */
export class WorkspaceAssociationStore {
    private readonly filePath: string;
    /** Serializes writes; a rejected write must not poison the chain. */
    private chain: Promise<void> = Promise.resolve();

    constructor(options: AssociationStoreOptions = {}) {
        this.filePath = workspaceAssociationsPath(options.home);
    }

    /**
     * The set stored at one key. Empty when the key has no entry.
     *
     * An explicitly empty set is indistinguishable from an absent one here —
     * the caller that needs the difference asks `resolve` for the source.
     */
    get(key: WorkspaceAssociationKey): string[] {
        const doc = this.load();
        const bucket = key.scope === "channel" ? doc.channels : doc.workspaces;
        const entry = bucket?.[normalizeAssociationKey(key)];
        if (!Array.isArray(entry)) return [];
        return entry.filter((v): v is string => typeof v === "string");
    }

    /**
     * The effective set for a workspace, after the scope fallback.
     *
     * A conversation's own entry wins when it exists. Otherwise the
     * channel's entry applies, so a channel-wide grant covers conversations
     * that have no entry of their own — including ones that start later.
     *
     * An empty set is stored as "no entry" (see `set`), so it falls back
     * rather than denying: saving an empty list for one conversation means
     * "this conversation has no associations of its own", not "this
     * conversation may reach nothing".
     *
     * Filesystem workspaces have no channel to fall back to: their cwd is not
     * a routing key, so there is nothing to inherit.
     */
    resolve(workspace: WorkspaceId): { roots: string[]; source?: WorkspaceAssociationKey } {
        const id = normalizeAssociationKey({ scope: "workspace", id: workspace });
        const own: WorkspaceAssociationKey = { scope: "workspace", id };
        const doc = this.load();
        const ownEntry = doc.workspaces?.[id];
        if (Array.isArray(ownEntry)) {
            return {
                roots: ownEntry.filter((v): v is string => typeof v === "string"),
                source: own,
            };
        }
        if (workspace.startsWith(IM_CWD_PREFIX)) {
            const route = parseImCwd(workspace);
            if (route) {
                const channelEntry = doc.channels?.[route.channelId];
                if (Array.isArray(channelEntry)) {
                    return {
                        roots: channelEntry.filter((v): v is string => typeof v === "string"),
                        source: { scope: "channel", id: route.channelId },
                    };
                }
            }
        }
        return { roots: [] };
    }

    /**
     * Replace the set stored at one key.
     *
     * The whole set is replaced — the caller sends the list it wants, so a
     * partial update would need a read-modify-write whose result could be
     * stale by the time it lands. An empty list removes the entry rather
     * than storing an empty one, so the channel fallback resumes to apply.
     */
    async set(key: WorkspaceAssociationKey, roots: readonly string[]): Promise<string[]> {
        const validated = this.validate(key, roots);
        const run = this.chain.then(async () => {
            const release = await this.acquireFileLock();
            try {
                // The lock must cover the read as well as the write. Separate
                // store instances are used by daemon connections, so a lock
                // only around persist() would still allow stale read-modify-
                // writes to discard another connection's entry.
                const doc = this.load();
                const bucket = key.scope === "channel" ? "channels" : "workspaces";
                const next: WorkspaceAssociationsDocument = { ...doc };
                const entries = { ...(next[bucket] ?? {}) };
                const id = normalizeAssociationKey(key);
                if (validated.length === 0) {
                    delete entries[id];
                } else {
                    entries[id] = validated;
                }
                next[bucket] = entries;
                next.version = ASSOCIATIONS_DOCUMENT_VERSION;
                await this.persist(next);
            } finally {
                await release();
            }
        });
        this.chain = run.catch(() => {});
        await run;
        return validated;
    }

    /**
     * Reject a root that must not become associated.
     *
     * The rules exist because an association IS a permission grant: the
     * model's `write` / `edit` fence widens to cover it. Each rule closes a
     * way that grant could reach further than the user meant.
     */
    private validate(key: WorkspaceAssociationKey, roots: readonly string[]): string[] {
        const out: string[] = [];
        const seen = new Set<string>();
        for (const root of roots) {
            if (typeof root !== "string" || root.length === 0) {
                throw new AssociationValidationError(
                    "root must be a non-empty string",
                    String(root),
                );
            }
            // The roots that are never a valid grant — $TACO_HOME in either
            // direction, the filesystem root, the home directory. Shared with
            // the IM policy's custom execution directory, which grants the
            // same thing by a different road.
            const safety = checkGrantRootSafety(root);
            if (!safety.ok) {
                throw new AssociationValidationError(`root ${safety.reason}`, root);
            }
            const real = realpathBestEffort(root);
            if (seen.has(real)) continue;
            seen.add(real);
            this.assertSafeRoot(key, root, real);
            out.push(root);
        }
        return out;
    }

    /**
     * The per-root safety rules.
     *
     * Split out from `validate` so each rule reads as one line of intent.
     */
    private assertSafeRoot(key: WorkspaceAssociationKey, root: string, real: string): void {
        // A workspace must not be granted an ancestor of its own root: that
        // would widen its reach beyond the directory the user picked, and the
        // extra room is not visible anywhere in the UI.
        //
        // Only filesystem workspaces have a root to compare against — an IM
        // workspace's id is a URL, and its working directory is a scratch
        // under $TACO_HOME, already excluded by the check above.
        //
        // The workspace's own path is compared as given: it is the directory
        // the user picked, and a workspace id that does not resolve to a
        // directory cannot contain anything.
        if (key.scope === "workspace" && !key.id.startsWith(IM_CWD_PREFIX)) {
            // The workspace's own directory, in its real form: `real` is
            // realpath'd, so comparing a merely-resolved path against it
            // would miss a symlinked parent (macOS resolves /var → /private/var)
            // and let the check pass when it should refuse.
            const own = realpathBestEffort(key.id);
            if (own !== real && isSameOrInside(own, real)) {
                throw new AssociationValidationError(
                    `root must not contain the workspace directory: ${root}`,
                    root,
                );
            }
        }
        // The root must exist and be a directory — an association to a path
        // that is not there grants nothing and hides the mistake.
        //
        // Stat the ORIGINAL path, not `real`: `realpathBestEffort` falls back
        // to the nearest existing ancestor, so a missing directory would
        // otherwise be checked as if it were that ancestor — passing the
        // existence test and comparing against the wrong root.
        let stat: fs.Stats;
        try {
            stat = fs.statSync(root);
        } catch {
            throw new AssociationValidationError(`root does not exist: ${root}`, root);
        }
        if (!stat.isDirectory()) {
            throw new AssociationValidationError(`root must be a directory: ${root}`, root);
        }
    }

    /**
     * Read the document from disk. A missing or corrupt file yields an empty
     * document — never fatal, so a bad edit cannot lock the user out.
     */
    private load(): WorkspaceAssociationsDocument {
        try {
            const raw = fs.readFileSync(this.filePath, "utf8");
            const parsed: unknown = JSON.parse(raw);
            if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
                return parsed as WorkspaceAssociationsDocument;
            }
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
                log.warn(`failed to read workspace associations: ${String(e)}`);
            }
        }
        return {};
    }

    private async persist(doc: WorkspaceAssociationsDocument): Promise<void> {
        await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
        const tmp = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`;
        await fs.promises.writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
        await restrictOwner(tmp, 0o600);
        try {
            await fs.promises.rename(tmp, this.filePath);
        } catch (e) {
            await fs.promises.rm(tmp, { force: true });
            throw e;
        }
    }

    /**
     * Acquire an inter-process lock using mkdir's atomic creation semantics.
     * The lock is intentionally a sibling of the document so all store
     * instances in a daemon, and separate Taco processes, coordinate.
     */
    private async acquireFileLock(): Promise<() => Promise<void>> {
        const lockPath = `${this.filePath}.lock`;
        while (true) {
            try {
                await fs.promises.mkdir(lockPath, { mode: 0o700 });
                const owner = randomUUID();
                await fs.promises.writeFile(path.join(lockPath, "owner"), owner, {
                    encoding: "utf8",
                    mode: 0o600,
                    flag: "wx",
                });
                return async () => {
                    try {
                        const currentOwner = await fs.promises.readFile(
                            path.join(lockPath, "owner"),
                            "utf8",
                        );
                        if (currentOwner === owner) {
                            await fs.promises.rm(lockPath, { recursive: true, force: true });
                        }
                    } catch (e) {
                        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
                    }
                };
            } catch (e) {
                if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
                try {
                    const stat = await fs.promises.stat(lockPath);
                    if (Date.now() - stat.mtimeMs > ASSOCIATIONS_LOCK_STALE_MS) {
                        await fs.promises.rm(lockPath, { recursive: true, force: true });
                        continue;
                    }
                } catch (statError) {
                    // A competing writer may have released the lock between
                    // mkdir and stat. Retry acquisition in that case.
                    if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
                    continue;
                }
                await new Promise((resolve) => setTimeout(resolve, ASSOCIATIONS_LOCK_RETRY_MS));
            }
        }
    }
}
