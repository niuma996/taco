/** Memory and workspace construction share Git's verified owner resolution. */
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { resolveGitProjectRoot } from "../git/gitService.ts";

/**
 * A Git file may identify a linked checkout; Git verifies its actual owner.
 * This keeps ordinary grants off the Git subprocess path while worktree ownership stays live.
 */
async function linkedCheckoutMarker(root: string): Promise<boolean> {
    for (let dir = root; ; dir = dirname(dir)) {
        try {
            return (await lstat(join(dir, ".git"))).isFile();
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (dirname(dir) === dir) return false;
    }
}

/** Unverifiable metadata retains the granted root's own partition. */
export async function resolveMemoryRoot(root: string): Promise<string> {
    if (!isAbsolute(root)) return root;
    try {
        if (!(await linkedCheckoutMarker(await realpath(root)))) return root;
    } catch (error) {
        // Missing roots may still belong to a recorded removed worktree.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return root;
    }
    try {
        return (await resolveGitProjectRoot(root)) ?? root;
    } catch {
        return root;
    }
}
