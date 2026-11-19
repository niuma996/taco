/** Filesystem access identities, distinct from public routing and persisted partition keys. */
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { IM_CWD_PREFIX } from "@taco-ai/protocol";

/** Resolve existing ancestors while retaining a missing tail; virtual identities stay literal. */
export function workspaceAccessPath(path: string): string {
    if (path.startsWith(IM_CWD_PREFIX)) return path;
    const absolute = resolve(path);
    try {
        return realpathSync.native(absolute);
    } catch {
        const parent = dirname(absolute);
        return parent === absolute
            ? absolute
            : join(workspaceAccessPath(parent), relative(parent, absolute));
    }
}

/** Compare already canonicalized roots without repeating filesystem reads. */
export function containsWorkspacePath(root: string, path: string): boolean {
    if (root.startsWith(IM_CWD_PREFIX) || path.startsWith(IM_CWD_PREFIX)) return root === path;
    const rel = relative(root, path);
    return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

export function workspacePathsOverlap(a: string, b: string): boolean {
    return containsWorkspacePath(a, b) || containsWorkspacePath(b, a);
}
