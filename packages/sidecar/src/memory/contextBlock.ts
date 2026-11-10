import type { MemoryEntry } from "./types.ts";

const MAX_TOPIC_NOTES = 100;
const MAX_TOPIC_BYTES = 32 * 1024;
const SEPARATOR = "\n\n---\n\n";

interface MemoryContextLayer {
    readonly heading: string;
    readonly entries: readonly MemoryEntry[];
}

interface MemoryContextOptions {
    readonly nameMaxChars?: number;
    readonly omittedNotice?: (count: number) => string;
    readonly omittedSeparator?: string;
}

/** Human memory is unbounded; all topic layers share one UTF-8 byte and count budget. */
export function buildMemoryContextBlock(
    memoryContent: string,
    layers: readonly MemoryContextLayer[],
    options: MemoryContextOptions = {},
): string {
    const total = layers.reduce((sum, layer) => sum + layer.entries.length, 0);
    const omittedNotice =
        options.omittedNotice ??
        (() => "Additional memory topics omitted to fit the context budget.");
    const omittedSeparator = options.omittedSeparator ?? SEPARATOR;
    // Reserve the largest omission count up front, including its separator.
    let bytes = Buffer.byteLength(omittedSeparator + omittedNotice(total));
    let count = 0;
    const parts: string[] = [];
    for (const layer of layers) {
        const startCount = count;
        const sorted = layer.entries
            .slice()
            .sort((a, b) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt));
        const lines: string[] = [];
        for (const topic of sorted) {
            const name = topic.name
                .replace(/[\r\n]+/g, " ")
                .trim()
                .slice(0, options.nameMaxChars);
            const description = topic.description
                .replace(/[\r\n]+/g, " ")
                .trim()
                .slice(0, 80);
            const line = `- [${topic.type}] ${name} — ${description} — ${topic.id}`;
            const text = lines.length === 0 ? `${SEPARATOR}${layer.heading}\n${line}` : `\n${line}`;
            const addedBytes = Buffer.byteLength(text);
            if (count >= MAX_TOPIC_NOTES || bytes + addedBytes > MAX_TOPIC_BYTES) break;
            bytes += addedBytes;
            count++;
            if (lines.length === 0) lines.push(layer.heading);
            lines.push(line);
        }
        if (lines.length) parts.push(lines.join("\n"));
        if (count - startCount < sorted.length) break;
    }
    let topics = parts.join(SEPARATOR);
    if (count < total) {
        topics += (topics ? omittedSeparator : "") + omittedNotice(total - count);
    }
    return [memoryContent, topics].filter(Boolean).join(SEPARATOR);
}
