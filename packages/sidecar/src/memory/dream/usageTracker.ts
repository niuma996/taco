/**
 * Topic usage tracking — records when the model opens a topic file with the
 * `read` tool.
 *
 * Injection is not usage: the newest topics are in every turn's `<memory>`
 * block whether they matter or not. Opening the full file is the signal that
 * a topic was actually needed, so it is the read time dream's staleness
 * check uses. Times go to `.dream/usage.json`, never the topic frontmatter,
 * so tracking cannot bump `updatedAt` or reorder injection.
 *
 * Writes are batched: reads accumulate in memory and flush on a debounce,
 * so a turn that opens ten topics costs one file write.
 */

import { basename, dirname, isAbsolute, resolve } from "node:path";
import { createLogger } from "../../lib/logger.ts";
import { recordTopicUsage } from "./dreamState.ts";

const log = createLogger("memory:usage");

const FLUSH_DELAY_MS = 5_000;

export interface TopicUsageTracker {
    /** Feed a `read` tool call's path; no-op unless it is a topic file. */
    noteRead(path: unknown): void;
    /** Write pending reads now (dispose, tests). */
    flush(): void;
}

export function createTopicUsageTracker(args: {
    readonly topicDir: string;
    /** Base for relative read paths, matching how the read tool resolves them. */
    readonly cwd: string;
    readonly now?: () => Date;
}): TopicUsageTracker {
    const topicDir = resolve(args.topicDir);
    const now = args.now ?? (() => new Date());
    let pending: Record<string, string> = {};
    let timer: ReturnType<typeof setTimeout> | undefined;

    const flush = (): void => {
        if (timer) {
            clearTimeout(timer);
            timer = undefined;
        }
        const batch = pending;
        pending = {};
        if (Object.keys(batch).length === 0) return;
        try {
            recordTopicUsage(topicDir, batch);
        } catch (error) {
            // Losing a usage stamp only makes a topic look older; never fail the turn.
            log.warn(
                "failed to record topic usage:",
                error instanceof Error ? error.message : String(error),
            );
        }
    };

    return {
        noteRead(path) {
            if (typeof path !== "string" || !path.endsWith(".md")) return;
            const absolute = isAbsolute(path) ? resolve(path) : resolve(args.cwd, path);
            // Top-level topic files only; archive/ and .dream/ are not topics.
            if (dirname(absolute) !== topicDir) return;
            pending[basename(absolute, ".md")] = now().toISOString();
            if (!timer) {
                timer = setTimeout(flush, FLUSH_DELAY_MS);
                timer.unref?.();
            }
        },
        flush,
    };
}
