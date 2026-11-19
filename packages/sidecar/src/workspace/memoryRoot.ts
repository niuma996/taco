/** Memory and workspace construction share Git's verified owner resolution. */
import { isAbsolute } from "node:path";
import { resolveGitProjectRoot } from "../git/gitService.ts";

/** Unverifiable metadata retains the granted root's own partition. */
export async function resolveMemoryRoot(root: string): Promise<string> {
    if (!isAbsolute(root)) return root;
    try {
        return (await resolveGitProjectRoot(root)) ?? root;
    } catch {
        return root;
    }
}
