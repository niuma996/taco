/**
 * fileTypes — pure front-end data contract for the Files drawer.
 *
 * No React / Tauri / third-party API dependencies. Easy to unit-test in isolation.
 */

export interface FileEntry {
    /** Path relative to cwd (using `/` as separator); "" means root. */
    relPath: string;
    name: string;
    kind: "file" | "dir";
    /** Files only; -1 when unknown. */
    size: number;
}

/** directory relPath → direct children */
export type DirectoryListing = Map<string, FileEntry[]>;

export const ALWAYS_HIDE_NAMES: ReadonlySet<string> = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    ".turbo",
    ".cache",
    ".pnpm-store",
    "out",
    "coverage",
    ".vite",
]);

export const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
    "png",
    "jpg",
    "jpeg",
    "gif",
    "webp",
    "svg",
    "ico",
    "bmp",
    "pdf",
    "doc",
    "docx",
    "xls",
    "xlsx",
    "ppt",
    "pptx",
    "zip",
    "tar",
    "gz",
    "bz2",
    "7z",
    "rar",
    "mp3",
    "mp4",
    "m4a",
    "wav",
    "flac",
    "ogg",
    "mov",
    "avi",
    "mkv",
    "wasm",
    "bin",
    "exe",
    "dylib",
    "so",
    "dmg",
    "lock",
    "node",
    "pdb",
    "o",
]);

export const TEXT_TRUNCATE_BYTES = 2 * 1024 * 1024;

/** Get the basename suffix; returns "" when there's no extension. */
export function getExtension(name: string): string {
    const i = name.lastIndexOf(".");
    if (i <= 0 || i === name.length - 1) return "";
    return name.slice(i + 1).toLowerCase();
}

/** Whether the file is binary. Extension blacklist wins; unknown extensions are treated as text. */
export function isBinary(name: string): boolean {
    return BINARY_EXTENSIONS.has(getExtension(name));
}

/** Filter: drop ALWAYS_HIDE_NAMES; showHidden controls dotfile visibility. */
export function filterEntries(entries: FileEntry[], opts: { showHidden: boolean }): FileEntry[] {
    return entries.filter((e) => {
        if (ALWAYS_HIDE_NAMES.has(e.name)) return false;
        if (!opts.showHidden && e.name.startsWith(".")) return false;
        return true;
    });
}

/** Sort: directories first, each group alphabetical case-insensitive. */
export function sortEntries(entries: FileEntry[]): FileEntry[] {
    return [...entries].sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
}
