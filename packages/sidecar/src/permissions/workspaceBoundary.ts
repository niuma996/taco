/**
 * Workspace containment for mutating tool calls.
 *
 * pi's `env.absolutePath` is `resolve(cwd, path)` with no boundary check, so a
 * model-supplied `../../etc/hosts` — or a symlink pointing out of the tree —
 * resolves cleanly and writes outside the workspace. Containment is therefore
 * enforced here rather than assumed from the tool implementation.
 */

import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

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
