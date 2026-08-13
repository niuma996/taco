/**
 * Convert a JSON Schema pointer (RFC 6901) like `/attachments/0/url` to a
 * plain `string[]` for the wire `invalid_params` issue path.
 *
 * Escaped reference tokens are decoded (`~1` → `/`, `~0` → `~`). Inputs that
 * are not rooted at `/` yield `[]`, which covers both the empty pointer (a
 * root-level error) and typebox's habit of reporting missing required keys
 * with an empty `instancePath`.
 */

export function parseJsonPointer(pointer: string): string[] {
    if (!pointer || pointer === "/") return [];
    return pointer
        .split("/")
        .slice(1)
        .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
}
