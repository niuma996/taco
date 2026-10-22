/**
 * The roots a workspace may never be granted.
 *
 * Two features hand the agent a directory beyond its own root:
 *   - an associated directory (the "关联目录" grant), and
 *   - an IM workspace's execution directory (the policy's "指定目录").
 *
 * Both widen what the model can read and write, so both are held to the same
 * rules. While these rules lived only in the association store, the policy's
 * custom execution directory was a way around all of them: it BECOMES the
 * IM workspace's root, and that root is what the read/write fence measures
 * against. A grant to $TACO_HOME therefore let the model read the API keys
 * in taco.json and rewrite the shell permission rules — silently, because
 * the policy path had no equivalent of the association store's checks.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { IM_CWD_PREFIX } from "@taco-ai/protocol";
import { tacoHome } from "../config/tacoHome.ts";

export type GrantRootVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Resolve a path to its real form, tolerating a not-yet-existing tail.
 *
 * A granted directory must exist, but these checks also run on paths that
 * later go away (a directory the user deleted after granting).
 * `realpathSync` on a missing path throws, so the ancestor walk keeps the
 * comparison meaningful for a path that has since disappeared.
 */
export function realpathBestEffort(target: string): string {
    let current = path.resolve(target);
    for (;;) {
        try {
            return fs.realpathSync(current);
        } catch {
            const parent = path.dirname(current);
            if (parent === current) return path.resolve(target);
            current = parent;
        }
    }
}

/**
 * True when `candidate` is `ancestor` or lives beneath it.
 *
 * Both sides are realpath'd first: a symlinked parent must not turn a
 * lexically-inside path into an outside one, nor the reverse.
 */
export function isSameOrInside(candidate: string, ancestor: string): boolean {
    const rel = path.relative(ancestor, candidate);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Check a directory against the roots that are never a valid grant:
 *
 *   - $TACO_HOME, in either direction. It holds taco.json (the provider API
 *     keys and the shell permission rules) and the session store, so a grant
 *     that reaches it lets the model turn off every later approval.
 *   - the filesystem root and the home directory — the two places where
 *     "a directory" means "everything".
 *
 * The reason is phrased to follow a subject, so callers can prefix it with
 * what they were checking ("root must …" / "execution directory must …").
 */
export function checkGrantRootSafety(root: string): GrantRootVerdict {
    if (!path.isAbsolute(root)) {
        return { ok: false, reason: `must be an absolute path: ${root}` };
    }
    if (root.startsWith(IM_CWD_PREFIX)) {
        return { ok: false, reason: `must be a filesystem path, not an IM workspace: ${root}` };
    }
    const real = realpathBestEffort(root);
    const home = realpathBestEffort(tacoHome());
    if (isSameOrInside(real, home) || isSameOrInside(home, real)) {
        return {
            ok: false,
            reason: `must not be inside or contain the Taco home directory: ${root}`,
        };
    }
    if (real === path.parse(real).root) {
        return { ok: false, reason: `must not be the filesystem root: ${root}` };
    }
    if (real === realpathBestEffort(os.homedir())) {
        return { ok: false, reason: `must not be the home directory: ${root}` };
    }
    return { ok: true };
}
