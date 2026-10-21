/**
 * Workspace containment for mutating tool calls.
 *
 * pi's `env.absolutePath` is `resolve(cwd, path)` with no boundary check, so a
 * model-supplied `../../etc/hosts` — or a symlink pointing out of the tree —
 * resolves cleanly and writes outside the workspace. Containment is therefore
 * enforced here rather than assumed from the tool implementation.
 */

import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Same set pi's `normalizeToolPath` folds to an ASCII space. */
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * Expand `~`, `~/…` and `file://…` exactly as pi's `NodeExecutionEnv`
 * `resolvePath` does before it resolves against cwd. Anything else is
 * returned unchanged. A containment check that skips this sees `~/.zshrc`
 * as a relative path inside the root while the tool writes to `$HOME`.
 */
export function expandHomeAndFileUrl(path: string): string {
    if (path === "~") return homedir();
    if (path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\"))) {
        return join(homedir(), path.slice(2));
    }
    if (path.startsWith("file://")) {
        try {
            return fileURLToPath(path);
        } catch {
            // pi keeps a malformed URL as an ordinary path; so do we.
            return path;
        }
    }
    return path;
}

/**
 * Mirror the full path pipeline pi's built-in `write` / `edit` apply
 * (`normalizeToolPath`, then `resolvePath`'s expansions), so the gate checks
 * the file the tool will actually touch rather than the raw argument.
 */
export function normalizeBuiltinToolPath(path: string): string {
    const spaced = path.replace(UNICODE_SPACES, " ");
    return expandHomeAndFileUrl(spaced.startsWith("@") ? spaced.slice(1) : spaced);
}

export interface BoundaryAllowed {
    readonly ok: true;
    /** Lexically resolved target; callers pass this to comparisons, not to fs. */
    readonly absolutePath: string;
}

export interface BoundaryDenied {
    readonly ok: false;
    readonly reason: string;
}

export type BoundaryResult = BoundaryAllowed | BoundaryDenied;

/**
 * Resolve symlinks as far as the path actually exists, then re-attach the
 * not-yet-created tail. A plain `realpath` would throw for new files, and
 * checking only the lexical path would miss an existing symlinked parent that
 * redirects the write out of the tree.
 */
async function realpathThroughExistingAncestor(target: string): Promise<string> {
    let current = target;
    for (;;) {
        try {
            const real = await realpath(current);
            return current === target ? real : resolve(real, relative(current, target));
        } catch {
            const parent = dirname(current);
            if (parent === current) return target;
            current = parent;
        }
    }
}

/** True when `target` is `root` itself or nested beneath it. */
function isContained(root: string, target: string): boolean {
    const rel = relative(root, target);
    // Cross-device paths on Windows come back absolute rather than as `..`.
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Resolve `rawPath` against `root` and reject anything that lands outside it.
 * Absolute inputs are honoured by `resolve` and then subjected to the same
 * containment check, so an absolute escape is refused like a relative one.
 */
export async function resolveWithinRoot(root: string, rawPath: string): Promise<BoundaryResult> {
    if (rawPath.trim() === "") {
        return { ok: false, reason: "path must not be empty" };
    }
    // Caller's responsibility: `root` must point at a real directory. We do
    // not stat it here because internal callers reuse this with synthetic
    // roots like `<workspace>/.taco/plans` that may not exist yet.
    const absolutePath = resolve(root, rawPath);
    const realRoot = await realpathThroughExistingAncestor(root);
    const realTarget = await realpathThroughExistingAncestor(absolutePath);
    if (!isContained(realRoot, realTarget)) {
        return {
            ok: false,
            reason: `path resolves outside the workspace root (${root}): ${rawPath}`,
        };
    }
    return { ok: true, absolutePath };
}

/**
 * Resolve `rawPath` against a workspace root plus the directories the user
 * associated with it, and accept it if it lands in either.
 *
 * A relative path resolves against the PRIMARY root only. The model's cwd is
 * the primary root, so "the file called `x`" means one specific thing; letting
 * an associated root re-anchor a relative path would make the same argument
 * mean different files depending on the grant. Associated roots therefore
 * only ever MATCH a path — one that resolves (relative to the primary root)
 * into the associated directory.
 *
 * Every root is compared through `realpathThroughExistingAncestor`, so a
 * symlinked root or a symlinked ancestor of the target cannot turn a
 * lexically-inside path into an outside one.
 */
export async function resolveWithinRootSet(
    primary: string,
    associated: readonly string[],
    rawPath: string,
): Promise<BoundaryResult> {
    if (rawPath.trim() === "") {
        return { ok: false, reason: "path must not be empty" };
    }
    const absolutePath = resolve(primary, rawPath);
    const realTarget = await realpathThroughExistingAncestor(absolutePath);

    const realPrimary = await realpathThroughExistingAncestor(primary);
    if (isContained(realPrimary, realTarget)) {
        return { ok: true, absolutePath };
    }

    for (const root of associated) {
        const realRoot = await realpathThroughExistingAncestor(root);
        if (isContained(realRoot, realTarget)) {
            return { ok: true, absolutePath };
        }
    }

    return {
        ok: false,
        reason:
            associated.length === 0
                ? `path resolves outside the workspace root (${primary}): ${rawPath}`
                : `path resolves outside the workspace root (${primary}) and its associated directories: ${rawPath}`,
    };
}
