/**
 * fileUrl — turn an absolute local path into a `file://` URL.
 *
 * The desktop client opens local files through the opener plugin's URL
 * command rather than its path command: the path scope is matched with the
 * filesystem glob rules, which on unix reject any path with a dot-leading
 * directory component (`~/.taco/workspace/...` never matches `**`). URL
 * scopes use plain glob matching, so those paths open normally.
 */

export function fileUrl(absPath: string): string {
    const normalized = absPath.replace(/\\/g, "/");
    const rooted = normalized.startsWith("/") ? normalized : `/${normalized}`;
    return `file://${rooted.split("/").map(encodePathSegment).join("/")}`;
}

/**
 * A Windows drive letter keeps its colon — it separates the drive from the
 * path in a file URL and must stay literal.
 */
function encodePathSegment(segment: string): string {
    return segment === "" ? "" : encodeURIComponent(segment).replace(/%3A/gi, ":");
}
