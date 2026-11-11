/**
 * Atomic file publishing for the sidecar's document stores.
 *
 * `writeTextAtomic` writes a unique temp file in the target's directory and
 * renames it into place. POSIX rename is atomic; on Windows it fails across
 * mount points, which is why the temp file never leaves that directory.
 * Durability across power loss is not claimed (no fsync).
 */
import { randomUUID } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";
import { restrictOwner } from "../lib/fsPermissions.ts";

export interface AtomicWriteOptions {
    /** Restrict the temp file to owner-only before publishing. */
    readonly secure?: boolean;
    /** POSIX mode when `secure`; defaults to 0o600. */
    readonly mode?: number;
    /** Pretty-print JSON at this indent; omit for compact output. */
    readonly indent?: number;
}

/** Write `body` to `final` via a unique temp file and `rename`. */
export async function writeTextAtomic(
    final: string,
    body: string,
    options: AtomicWriteOptions = {},
): Promise<void> {
    const tmp = `${final}.${process.pid}.${randomUUID()}.tmp`;
    const mode = options.mode ?? 0o600;
    try {
        // `mode` at creation matters: a chmod after the write leaves a window
        // where a credential-bearing temp file is world-readable.
        await writeFile(tmp, body, options.secure ? { encoding: "utf8", mode } : "utf8");
        if (options.secure) await restrictOwner(tmp, mode);
        await rename(tmp, final);
    } finally {
        await unlink(tmp).catch(() => undefined);
    }
}

/** Serialize `value` and publish it with {@link writeTextAtomic}. */
export function writeJsonAtomic(
    final: string,
    value: unknown,
    options: AtomicWriteOptions = {},
): Promise<void> {
    return writeTextAtomic(final, JSON.stringify(value, null, options.indent), options);
}
