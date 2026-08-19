/** Mirror of `packages/sidecar/src/lib/installId.ts::computeInstallId`.
 *
 *  The CLI cannot import from `@taco-ai/sidecar` (only the bundled platform
 *  pkg ships at runtime, not the TS source), so we duplicate the algorithm.
 *  Both sides MUST stay byte-for-byte identical — any drift means the
 *  desktop reap path will skip a daemon it owns (or kill one it doesn't).
 *  The unit test in `tests/installId.test.ts` enforces identical output
 *  against a fixed corpus of inputs.
 */
import { createHash } from "node:crypto";

export function computeInstallId(resourcesRoot: string, tacoHome: string): string {
    const h = createHash("sha256");
    h.update(resourcesRoot);
    h.update("\0");
    h.update(tacoHome);
    return h.digest("hex").slice(0, 16);
}

/** Parse the contents of $TACO_HOME/run/sidecar.pid.
 *
 *  Two on-disk formats are accepted:
 *    - **JSON record** (current, written by the daemon post-PR-A): a JSON
 *      object with `{version, pid, install_id, started_at}`. The version
 *      field exists so future schema changes can fail loudly rather than
 *      silently misparse old files.
 *    - **Legacy bare-int** (pre-PR-A): a single decimal pid string. Kept
 *      readable so a desktop upgrade doesn't strand an already-running
 *      daemon's pid file — the next reap on the new code will overwrite
 *      it once a fresh daemon starts.
 *
 *  Returns null when the file is absent, unparseable, or yields a
 *  non-finite pid. Callers must treat null as "no claim to ownership" and
 *  not signal/kill anything. */
export interface ParsedPidFile {
    pid: number;
    installId: string | null;
    startedAt: string | null;
    /** Schema version, when the on-disk format is JSON. null for legacy. */
    version: number | null;
}

export function parsePidFile(contents: string): ParsedPidFile | null {
    const trimmed = contents.trim();
    if (trimmed.length === 0) return null;

    // Try JSON first. The version field is the discriminator: a bare-int
    // pid (e.g. "12345\n") is the legacy format; anything starting with
    // "{" is the new JSON record. JSON.parse of a bare int would throw,
    // so a try/catch is cheap insurance against ambiguous input.
    if (trimmed.startsWith("{")) {
        try {
            const parsed = JSON.parse(trimmed) as Record<string, unknown>;
            if (parsed.version !== 1) {
                // Unknown schema — caller can choose to log + unlink rather
                // than act on a record whose shape we don't recognise.
                return null;
            }
            const pid = typeof parsed.pid === "number" ? parsed.pid : Number.NaN;
            const installId = typeof parsed.install_id === "string" ? parsed.install_id : null;
            const startedAt = typeof parsed.started_at === "string" ? parsed.started_at : null;
            if (!Number.isFinite(pid) || pid <= 0) return null;
            return { pid, installId, startedAt, version: 1 };
        } catch {
            return null;
        }
    }

    // Legacy fallback. Some pid files may have whitespace or a trailing
    // newline — trim already handled that. parseInt is permissive so we
    // sanity-check with isFinite + positive.
    const pid = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    return { pid, installId: null, startedAt: null, version: null };
}
