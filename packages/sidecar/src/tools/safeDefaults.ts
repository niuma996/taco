/**
 * Safe-default ignore globs shared by the file tools and project-manifest
 * scans. Base list excludes generated / vendored trees the LLM should not
 * read wholesale. `MANIFEST_SAFE_DEFAULT_IGNORES` additionally excludes
 * Rust/Cargo `target/` output — that one is scoped to manifest scanning
 * (a project may legitimately be inspected by a user working in `target/`).
 */
export const BASE_SAFE_DEFAULT_IGNORES: string[] = [
    "**/node_modules/**",
    "**/.git/**",
    "**/dist/**",
    "**/build/**",
    "**/.next/**",
];

export const MANIFEST_SAFE_DEFAULT_IGNORES: string[] = [
    ...BASE_SAFE_DEFAULT_IGNORES,
    "**/target/**",
];
