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

/** Image extensions previewable inline, mapped to their MIME type. Image files stay in BINARY_EXTENSIONS too; previewKindFor checks this set first. */
export const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    ico: "image/x-icon",
    svg: "image/svg+xml",
    avif: "image/avif",
};

/** Files larger than this are not read for preview — the "too large" state shows instead. */
export const MAX_PREVIEW_BYTES = 512 * 1024;

/** Image previews travel over IPC then expand by ~33% as base64, so they get a larger cap than text. */
export const MAX_IMAGE_PREVIEW_BYTES = 10 * 1024 * 1024;

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

/** MIME type when the file is an inline-previewable image; null otherwise. */
export function imageMimeFor(name: string): string | null {
    return IMAGE_EXTENSIONS[getExtension(name)] ?? null;
}

/**
 * Extension → shiki language id for syntax highlighting. This is the preview
 * allowlist: extensions absent here (and not binary) are "unsupported" and
 * the popup shows a hint + reveal-in-folder button instead of reading them.
 * "text" = previewed without highlighting; "markdown" additionally gets a
 * rendered/source toggle.
 */
export const PREVIEW_LANGUAGES: Readonly<Record<string, string>> = {
    // plain text (no highlight)
    txt: "text",
    log: "text",
    csv: "text",
    // docs
    md: "markdown",
    markdown: "markdown",
    // web
    js: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    jsx: "jsx",
    ts: "typescript",
    mts: "typescript",
    cts: "typescript",
    tsx: "tsx",
    json: "json",
    jsonc: "jsonc",
    html: "html",
    htm: "html",
    css: "css",
    scss: "scss",
    less: "less",
    vue: "vue",
    svelte: "svelte",
    // systems / app languages
    py: "python",
    rs: "rust",
    go: "go",
    java: "java",
    kt: "kotlin",
    cs: "csharp",
    c: "c",
    h: "c",
    cpp: "cpp",
    cc: "cpp",
    cxx: "cpp",
    hpp: "cpp",
    rb: "ruby",
    php: "php",
    swift: "swift",
    lua: "lua",
    // shell / config / data
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    ini: "ini",
    xml: "xml",
    sql: "sql",
    graphql: "graphql",
    dockerfile: "dockerfile",
    diff: "diff",
};

export type PreviewKind =
    | "image"
    | "markdown"
    | "html"
    | "code"
    | "text"
    | "binary"
    | "unsupported";

/** Classify a file for the preview popup. Extension-less files preview as plain text. */
export function previewKindFor(name: string): PreviewKind {
    if (imageMimeFor(name) !== null) return "image";
    if (isBinary(name)) return "binary";
    const ext = getExtension(name);
    if (ext === "") return "text";
    const lang = PREVIEW_LANGUAGES[ext];
    if (lang === undefined) return "unsupported";
    if (lang === "markdown") return "markdown";
    if (lang === "html") return "html";
    if (lang === "text") return "text";
    return "code";
}

/** shiki language id for highlighting; "text" when the kind has no grammar. */
export function shikiLangFor(name: string): string {
    return PREVIEW_LANGUAGES[getExtension(name)] ?? "text";
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
