/** Existing storage layouts, shared by writers and workspace cleanup. */
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { tacoHome } from "../config/tacoHome.ts";

/** Memory normalizes separators; checkpoints retain their historical raw identity hash. */
export function memoryPartitionKey(identity: string): string {
    return hash(identity.replace(/\\/g, "/"));
}

function hash(identity: string): string {
    return createHash("sha256").update(identity).digest("hex").slice(0, 16);
}

export function memoryStoragePaths(home: string = tacoHome()): {
    root: string;
    indexPath: string;
    projectsDir: string;
} {
    const root = resolve(home, "memory");
    return { root, indexPath: join(root, "MEMORY.md"), projectsDir: join(root, "projects") };
}

export function memoryProjectDir(identity: string, home: string = tacoHome()): string {
    return join(memoryStoragePaths(home).projectsDir, memoryPartitionKey(identity));
}

export function checkpointStoragePaths(
    identity: string,
    home: string = tacoHome(),
): {
    root: string;
    blobsDir: string;
    indexPath: string;
} {
    const root = join(home, "checkpoints", hash(identity));
    return { root, blobsDir: join(root, "blobs"), indexPath: join(root, "index.json") };
}
