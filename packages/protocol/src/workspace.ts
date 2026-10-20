/**
 * Workspace association types — the directories a workspace may reach beyond
 * its own root.
 *
 * A workspace's tool permissions are rooted at a set of directories:
 *
 *   roots[0]  the workspace's own root (its cwd) — relative paths resolve here
 *   roots[1..] associated directories — absolute-path access only
 *
 * The distinction matters because `executionCwd` is the cwd: shell runs
 * there, relative paths resolve against it, and the fs tools' containment
 * check anchors there. An associated directory is a peer of that root for
 * permission purposes, but never a cwd — a relative path still means
 * "relative to the workspace root".
 *
 * Storage is keyed by *scope* rather than by workspace alone, because the
 * admin picks the granularity: a whole IM channel, or one conversation
 * inside it. `scope: "channel"` entries are shared by every conversation on
 * that channel; `scope: "workspace"` entries belong to one workspace and
 * override the channel entry when present.
 */

import type { WorkspaceId } from "./frames.js";

/**
 * Which level an association set is stored at.
 *
 * - `workspace` — one workspace: a filesystem cwd, or one IM conversation
 *   (`im://<channelId>/<peerId>/<chatId>`).
 * - `channel` — every conversation on one IM channel.
 */
export type WorkspaceAssociationScope = "workspace" | "channel";

/**
 * The key an association set is stored under.
 *
 * `workspace` scope uses the workspace id itself; `channel` scope uses the
 * channel id. The two live in separate namespaces, so a channel id that
 * happens to look like a path cannot collide with a workspace entry.
 */
export interface WorkspaceAssociationKey {
    readonly scope: WorkspaceAssociationScope;
    readonly id: string;
}

/** `workspace.getAssociations` params — read the set stored at one key. */
export interface WorkspaceAssociationsGetParams {
    readonly key: WorkspaceAssociationKey;
}

/** `workspace.getAssociations` result — the set stored at one key. */
export interface WorkspaceAssociationsGetResult {
    /** Absolute directory paths. Empty when the key has no entry. */
    readonly roots: readonly string[];
}

/**
 * `workspace.setAssociations` params — replace the set stored at one key.
 *
 * The whole set is replaced, not merged: the client sends the full list it
 * wants. A partial update would need a read-modify-write round trip whose
 * result could be stale by the time it lands.
 */
export interface WorkspaceAssociationsSetParams {
    readonly key: WorkspaceAssociationKey;
    readonly roots: readonly string[];
}

/** `workspace.setAssociations` result — the set as stored. */
export interface WorkspaceAssociationsSetResult {
    readonly roots: readonly string[];
}

/**
 * `workspace.resolveAssociations` params — the effective set for a workspace.
 *
 * Distinct from `getAssociations`: this applies the fallback rule (a
 * conversation's own entry wins over its channel's) so the client does not
 * have to reimplement it.
 */
export interface WorkspaceAssociationsResolveParams {
    readonly workspace: WorkspaceId;
}

/** `workspace.resolveAssociations` result. */
export interface WorkspaceAssociationsResolveResult {
    /** The effective roots — the conversation's own entry, else the channel's. */
    readonly roots: readonly string[];
    /** Which key supplied them. `undefined` when nothing is associated. */
    readonly source?: WorkspaceAssociationKey;
}
