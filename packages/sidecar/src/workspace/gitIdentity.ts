import { lstat } from "node:fs/promises";

/** Directory replacement must invalidate ownership even when Git reuses the same path. */
export async function gitDirectoryIdentity(path: string): Promise<string> {
    const entry = await lstat(path, { bigint: true });
    if (!entry.isDirectory() || entry.isSymbolicLink())
        throw new Error("Git metadata directory is unsafe");
    return `${entry.dev}:${entry.ino}:${entry.birthtimeNs}`;
}
