import type { GitFileChange } from "@taco-ai/protocol";
import { type DirectoryListing, filterEntries, sortEntries } from "./fileTypes";

const priority: Record<GitFileChange["kind"], number> = {
    added: 0,
    renamed: 1,
    modified: 2,
    deleted: 3,
    conflict: 4,
};

export function gitStatusLetter(change: GitFileChange): "A" | "M" | "D" | "R" | "U" {
    const letters = {
        added: "A",
        modified: "M",
        deleted: "D",
        renamed: "R",
        conflict: "U",
    } as const;
    return letters[change.kind];
}

export function gitStatusTone(change: GitFileChange): "success" | "warning" | "danger" {
    if (change.kind === "added") return "success";
    if (change.kind === "deleted" || change.kind === "conflict") return "danger";
    return "warning";
}

/** Merge status paths into a snapshot without re-reading directories or changing the cache. */
export function gitFileTree(
    snapshot: DirectoryListing,
    changes: readonly GitFileChange[],
    showHidden: boolean,
) {
    const entriesByDir = new Map(snapshot);
    const statuses = new Map<string, GitFileChange>();
    for (const change of changes) {
        if (!Object.hasOwn(priority, change.kind)) continue;
        const parts = change.path.replace(/\/$/, "").split("/");
        if (
            parts.some((name) => !name || name === "." || name === "..") ||
            change.path.startsWith("/")
        )
            continue;
        let parent = "";
        for (let index = 0; index < parts.length; index++) {
            const name = parts[index];
            const relPath = parent ? `${parent}/${name}` : name;
            const isDir = index < parts.length - 1 || change.path.endsWith("/");
            const entry = {
                name,
                relPath,
                kind: isDir ? ("dir" as const) : ("file" as const),
                size: -1,
            };
            if (!filterEntries([entry], { showHidden }).length) break;
            const siblings = entriesByDir.get(parent) ?? [];
            if (!siblings.some((sibling) => sibling.relPath === relPath)) {
                entriesByDir.set(parent, sortEntries([...siblings, entry]));
            }
            const previous = statuses.get(relPath);
            if (!previous || priority[change.kind] > priority[previous.kind])
                statuses.set(relPath, change);
            parent = relPath;
        }
    }
    return { entriesByDir, statuses };
}
