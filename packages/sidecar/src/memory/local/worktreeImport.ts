/** One-time, lossless import of a worktree's old memory partition. */
import { createHash, randomUUID } from "node:crypto";
import {
    link,
    lstat,
    mkdir,
    readdir,
    readFile,
    realpath,
    unlink,
    writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

async function exists(path: string) {
    try {
        return await lstat(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    }
}

async function directory(path: string, create = false): Promise<boolean> {
    let entry = await exists(path);
    if (!entry && create) {
        try {
            await mkdir(path);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        entry = await lstat(path);
    }
    if (!entry) return false;
    if (!entry.isDirectory() || entry.isSymbolicLink())
        throw new Error("Unsafe workspace memory import directory");
    return true;
}

async function matches(path: string, bytes: Buffer): Promise<boolean | undefined> {
    const entry = await exists(path);
    if (!entry) return undefined;
    if (!entry.isFile() || entry.isSymbolicLink())
        throw new Error("Unsafe workspace memory import file");
    return bytes.equals(await readFile(path));
}

/** Publish complete bytes without replacing any existing destination. */
async function publish(path: string, bytes: Buffer): Promise<boolean> {
    const same = await matches(path, bytes);
    if (same === true) return false;
    if (same === false) throw new Error("Workspace memory import destination is occupied");
    const temporary = join(dirname(path), `.import-${randomUUID()}.tmp`);
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    try {
        try {
            await link(temporary, path);
            return true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            if (await matches(path, bytes)) return false;
            throw new Error("Workspace memory import destination is occupied");
        }
    } finally {
        await unlink(temporary).catch(() => undefined);
    }
}

function collisionName(file: string, sourceKey: string, path: string): string {
    const suffix = createHash("sha256")
        .update(`${sourceKey}\0${path.split(sep).join("/")}`)
        .digest("hex")
        .slice(0, 16);
    const stem =
        file
            .slice(0, -3)
            .toLowerCase()
            .replace(/[^a-z0-9_-]/g, "-")
            .replace(/^[^a-z0-9]+/, "") || "topic";
    return `${stem.slice(0, 47)}-${suffix}.md`;
}

/** Caller serializes all imports and ordinary mutations for this destination. */
export async function importWorktreeMemory(source: string, destination: string): Promise<boolean> {
    source = resolve(source);
    destination = resolve(destination);
    if (source === destination) return false;
    const projects = dirname(destination);
    if (dirname(source) !== projects) throw new Error("Invalid workspace memory import source");
    // The configured home may be an intentional alias; descendants must not be links.
    await directory(await realpath(dirname(dirname(projects))));
    await directory(dirname(projects));
    await directory(projects);
    await directory(destination);
    const sourceKey = basename(source);
    const marker = join(destination, `.worktree-import-${sourceKey}.json`);
    const completion = Buffer.from(JSON.stringify({ version: 1, source: sourceKey }));
    const completed = await matches(marker, completion);
    if (completed === true) return false;
    if (completed === false) throw new Error("Invalid workspace memory import marker");
    const available = await directory(source);
    let changed = false;
    const copy = async (file: string): Promise<void> => {
        const path = relative(source, file);
        let parent = destination;
        for (const part of path.split(sep).slice(0, -1)) {
            parent = join(parent, part);
            await directory(parent, true);
        }
        const bytes = await readFile(file);
        const primary = join(parent, basename(file));
        const same = await matches(primary, bytes);
        if (same === true) return;
        const collision = join(parent, collisionName(basename(file), sourceKey, path));
        const imported = await matches(collision, bytes);
        if (imported === true) return;
        // A retry must reuse its reserved collision path even if the primary was deleted.
        const target = same === false || imported !== undefined ? collision : primary;
        changed = (await publish(target, bytes)) || changed;
    };
    const visit = async (path: string, recursive: boolean): Promise<void> => {
        const entries = await readdir(path, { withFileTypes: true });
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            const child = join(path, entry.name);
            if (entry.isFile() && entry.name.endsWith(".md")) await copy(child);
            else if (recursive && entry.isDirectory()) await visit(child, true);
        }
    };
    if (available) {
        await visit(source, false);
        const archive = join(source, "archive");
        const entry = await exists(archive);
        if (entry?.isDirectory() && !entry.isSymbolicLink()) await visit(archive, true);
    }
    await publish(marker, completion);
    return changed;
}
