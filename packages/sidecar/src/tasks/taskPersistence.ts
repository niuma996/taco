import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../lib/logger.ts";
import type { TaskList } from "./taskTypes.ts";

const log = createLogger("tasks");

/**
 * Current on-disk schema version for task lists. Files written before
 * versioning have no `schemaVersion` and are read as v1; files from a newer
 * sidecar are skipped rather than parsed with a stale shape.
 */
export const TASK_LIST_SCHEMA_VERSION = 1;

export async function saveTaskListToDisk(baseDir: string, list: TaskList): Promise<void> {
    await mkdir(baseDir, { recursive: true });
    const filePath = join(baseDir, `${list.id}.json`);
    await writeFile(
        filePath,
        JSON.stringify({ schemaVersion: TASK_LIST_SCHEMA_VERSION, ...list }, null, 2),
        "utf-8",
    );
}

/** Parse one task list, treating a missing version as v1 and skipping newer ones. */
function parseTaskList(content: string, filePath: string): TaskList | undefined {
    const parsed = JSON.parse(content) as TaskList;
    const version = parsed.schemaVersion ?? TASK_LIST_SCHEMA_VERSION;
    if (version > TASK_LIST_SCHEMA_VERSION) {
        log.warn(`skipping task file ${filePath}: unsupported schemaVersion ${version}`);
        return undefined;
    }
    return parsed;
}

export async function loadTaskList(baseDir: string, listId: string): Promise<TaskList | undefined> {
    try {
        const filePath = join(baseDir, `${listId}.json`);
        const content = await readFile(filePath, "utf-8");
        return parseTaskList(content, filePath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
        }
        throw error;
    }
}

/** Read every *.json task list under a directory (used to hydrate on attach).
 *  Returns [] when the directory does not exist. */
export async function loadAllTaskLists(baseDir: string): Promise<TaskList[]> {
    let files: string[];
    try {
        files = await readdir(baseDir);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
    }
    const lists: TaskList[] = [];
    for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const p = join(baseDir, file);
        try {
            const content = await readFile(p, "utf-8");
            const parsed = parseTaskList(content, p);
            if (parsed) lists.push(parsed);
        } catch (err) {
            // best-effort: skip corrupt entries so one bad file doesn't block attach
            log.warn(`skipping corrupt task file ${p}: ${(err as Error).message}`);
        }
    }
    return lists;
}
