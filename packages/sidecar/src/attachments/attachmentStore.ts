/**
 * Attachment storage: stage a file, then commit it into a session directory.
 *
 * Staging exists because the first message of a new session is sent before the
 * session does, so there is no session directory to copy into yet. Staging
 * also pins the content: the file is copied when the user picks it, so a later
 * edit to the original does not change what the message says it carried.
 *
 *   staging   <stagingBase>/<workspaceKey>/<id>/<safeName>
 *   committed <sessionsRoot>/<sid>/attachments/<id>-<safeName>
 *
 * Committed files live under `<sessionsRoot>/<sid>`, which `session.delete`
 * already removes recursively; nothing here needs its own delete path.
 *
 * The id is the only handle a client holds. A prompt names ids, never paths,
 * so a prompt cannot point the sidecar at an arbitrary file.
 */

import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import {
    ATTACHMENT_MAX_BYTES,
    ATTACHMENT_STAGE_INLINE_MAX_BYTES,
    type AttachmentKind,
    type AttachmentRefusalReason,
    type AttachmentStageResult,
    type MessageAttachment,
} from "@taco-ai/protocol";

import { tacoHome } from "../config/tacoHome.ts";
import { restrictOwner } from "../lib/fsPermissions.ts";
import { detectMimeType, isModelImageMime } from "./mimeType.ts";

/** A staged file older than this is swept at startup. */
export const ATTACHMENT_STAGING_TTL_MS = 24 * 60 * 60 * 1000;

/** Longest file name kept. Names are display text; the id keeps them unique. */
const MAX_NAME_LENGTH = 120;

/** A refusal the caller should show to the user, not log as a fault. */
export class AttachmentError extends Error {
    constructor(
        readonly code: AttachmentRefusalReason,
        message: string,
    ) {
        super(message);
        this.name = "AttachmentError";
    }
}

/** `<tacoHome>/staging/attachments` — the parent of every workspace's staging tree. */
export function stagingBase(): string {
    return join(tacoHome(), "staging", "attachments");
}

/**
 * Per-workspace staging root. The workspace id is a filesystem path, so it is
 * hashed: a workspace cannot reach another's staged ids, and the path never
 * appears in the staging tree.
 */
export function stagingRoot(workspaceId: string): string {
    const key = createHash("sha256").update(workspaceId).digest("hex").slice(0, 32);
    return join(stagingBase(), key);
}

/** `<sessionsRoot>/<sid>/attachments` — where committed files live. */
export function sessionAttachmentsDir(sessionsRoot: string, sessionId: string): string {
    return join(sessionsRoot, sessionId, "attachments");
}

/**
 * Reduce a client-supplied name to something safe as one path segment.
 *
 * Only the final component is kept, and anything that could change the
 * meaning of a path or confuse a terminal is replaced. The result is never
 * empty and never `.` or `..`.
 */
export function safeFileName(raw: string): string {
    const base = basename(raw.replace(/\\/g, "/"));
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
    const cleaned = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_").trim();
    const bounded = cleaned.length > MAX_NAME_LENGTH ? truncateKeepingExtension(cleaned) : cleaned;
    if (bounded === "" || bounded === "." || bounded === "..") return "file";
    return bounded;
}

function truncateKeepingExtension(name: string): string {
    const ext = extname(name);
    const keep = Math.max(1, MAX_NAME_LENGTH - ext.length);
    return `${name.slice(0, keep)}${ext}`;
}

/** Ids are uuids we minted; anything else is rejected before touching a path. */
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function requireValidId(id: string): void {
    if (!ID_PATTERN.test(id)) {
        throw new AttachmentError("bad_id", `not a staged attachment id: ${id}`);
    }
}

async function classify(path: string, declaredMime: string | undefined, name: string) {
    const mimeType = await detectMimeType(path, declaredMime, name);
    const kind: AttachmentKind = isModelImageMime(mimeType) ? "image" : "file";
    return { mimeType, kind };
}

/**
 * Copy a local file into staging.
 *
 * The copy is owner-only: the source may be a private file (`0600`), and a
 * copy made with the default umask would be readable by other local accounts
 * for as long as it stays staged.
 */
export async function stageFromPath(
    workspaceId: string,
    sourcePath: string,
): Promise<AttachmentStageResult> {
    let info: Awaited<ReturnType<typeof stat>>;
    try {
        info = await stat(sourcePath);
    } catch {
        throw new AttachmentError("not_found", `file not found: ${sourcePath}`);
    }
    if (!info.isFile()) {
        throw new AttachmentError("not_a_file", `not a regular file: ${sourcePath}`);
    }
    if (info.size > ATTACHMENT_MAX_BYTES) {
        throw new AttachmentError(
            "too_large",
            `file is ${info.size} bytes; the limit is ${ATTACHMENT_MAX_BYTES}`,
        );
    }
    const id = randomUUID();
    const name = safeFileName(sourcePath);
    const dir = join(stagingRoot(workspaceId), id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await restrictOwner(dir, 0o700);
    const dest = join(dir, name);
    try {
        await copyFile(sourcePath, dest);
        await restrictOwner(dest, 0o600);
    } catch (e) {
        await rm(dir, { recursive: true, force: true });
        throw e;
    }
    const { mimeType, kind } = await classify(dest, undefined, name);
    return { id, name, mimeType, size: info.size, kind };
}

/** Write an inline base64 body (the paste path) into staging. */
export async function stageFromData(
    workspaceId: string,
    rawName: string,
    base64: string,
    declaredMime: string | undefined,
): Promise<AttachmentStageResult> {
    const bytes = Buffer.from(base64, "base64");
    if (bytes.length > ATTACHMENT_STAGE_INLINE_MAX_BYTES) {
        throw new AttachmentError(
            "too_large",
            `pasted data is ${bytes.length} bytes; the limit is ${ATTACHMENT_STAGE_INLINE_MAX_BYTES}`,
        );
    }
    const id = randomUUID();
    const name = safeFileName(rawName);
    const dir = join(stagingRoot(workspaceId), id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await restrictOwner(dir, 0o700);
    const dest = join(dir, name);
    try {
        await writeFile(dest, bytes, { mode: 0o600 });
        await restrictOwner(dest, 0o600);
    } catch (e) {
        await rm(dir, { recursive: true, force: true });
        throw e;
    }
    const { mimeType, kind } = await classify(dest, declaredMime, name);
    return { id, name, mimeType, size: bytes.length, kind };
}

/**
 * Move staged files into a session's attachment directory and describe them.
 *
 * All ids are resolved before anything moves, so one bad id does not leave a
 * message half-committed. A missing staged file (swept, an id from another
 * sidecar run, or staged by a different workspace) is a `not_found` the client
 * can surface as "re-attach it".
 */
export async function commitAttachments(
    ids: readonly string[],
    workspaceId: string,
    sessionsRoot: string,
    sessionId: string,
): Promise<MessageAttachment[]> {
    if (ids.length === 0) return [];
    const stagedRoot = stagingRoot(workspaceId);
    const resolved: Array<{ id: string; name: string; staged: string }> = [];
    for (const id of new Set(ids)) {
        requireValidId(id);
        const dir = join(stagedRoot, id);
        let entries: string[];
        try {
            entries = await readdir(dir);
        } catch {
            throw new AttachmentError(
                "not_found",
                `attachment ${id} is no longer available; attach the file again`,
            );
        }
        const name = entries[0];
        if (name === undefined) {
            throw new AttachmentError(
                "not_found",
                `attachment ${id} is no longer available; attach the file again`,
            );
        }
        resolved.push({ id, name, staged: join(dir, name) });
    }

    const destDir = sessionAttachmentsDir(sessionsRoot, sessionId);
    await mkdir(destDir, { recursive: true, mode: 0o700 });
    await restrictOwner(destDir, 0o700);
    const out: MessageAttachment[] = [];
    for (const { id, name, staged } of resolved) {
        const dest = join(destDir, `${id}-${name}`);
        const info = await stat(staged);
        const { mimeType, kind } = await classify(staged, undefined, name);
        await moveFile(staged, dest);
        // The rename keeps the staged mode, but the cross-device copy fallback
        // creates the file with the umask; apply the mode on both paths.
        await restrictOwner(dest, 0o600);
        await rm(join(stagedRoot, id), { recursive: true, force: true });
        out.push({ name, mimeType, size: info.size, path: dest, kind });
    }
    return out;
}

/** `rename` fails across devices (tmp on another volume); fall back to copy + delete. */
async function moveFile(from: string, to: string): Promise<void> {
    try {
        await rename(from, to);
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
        await copyFile(from, to);
        await rm(from, { force: true });
    }
}

/** Remove staged directories older than the TTL. Safe to run at every startup. */
export async function sweepStaging(now: number = Date.now()): Promise<number> {
    let workspaces: string[];
    try {
        workspaces = await readdir(stagingBase());
    } catch {
        return 0;
    }
    let removed = 0;
    for (const workspace of workspaces) {
        const workspaceDir = join(stagingBase(), workspace);
        let entries: string[];
        try {
            entries = await readdir(workspaceDir);
        } catch {
            continue;
        }
        for (const entry of entries) {
            const dir = join(workspaceDir, entry);
            try {
                const info = await stat(dir);
                if (now - info.mtimeMs < ATTACHMENT_STAGING_TTL_MS) continue;
                await rm(dir, { recursive: true, force: true });
                removed++;
            } catch {
                // A directory that vanished or is unreadable is not worth failing startup over.
            }
        }
    }
    return removed;
}
