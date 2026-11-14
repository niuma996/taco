import matter from "gray-matter";
import {
    MEMORY_ENTRY_TYPES,
    type MemoryEntry,
    type MemoryEntryType,
    unionMemorySources,
} from "../types.ts";

type TopicFrontmatter = Omit<MemoryEntry, "id" | "content" | "workspaceId" | "createdAt"> & {
    createdAt?: string;
};

/** Keep topic names and relevance descriptions on one line. */
export function frontmatterValue(value: string): string {
    return value.replace(/[\r\n]+/g, " ").trim();
}

/** Encode new topics as versioned YAML; unmarked files retain literal legacy semantics. */
export function buildTopicFile(entry: MemoryEntry): string {
    if (!entry.name.trim()) throw new Error("memory topic name must not be blank");
    const encoded = matter.stringify(
        { content: `\n${entry.content.trim()}` },
        {
            topicCodec: 1,
            name: frontmatterValue(entry.name),
            description: frontmatterValue(entry.description),
            type: entry.type,
            createdAt: entry.createdAt,
            ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
            ...(entry.archivedAt ? { archivedAt: entry.archivedAt } : {}),
            ...(entry.explicitlyRequested === undefined
                ? {}
                : { explicitlyRequested: entry.explicitlyRequested }),
            ...(entry.sources?.length ? { sources: unionMemorySources(entry.sources) } : {}),
        },
    );
    // Keep fields consumed by pre-codec Taco releases in their old form during
    // rollback: Date.parse(createdAt) and JSON.parse(sources) must still work.
    const lines = encoded.split("\n");
    const closing = lines.findIndex((line, index) => index > 0 && line === "---");
    if (closing < 0) return encoded;
    for (let index = 1; index < closing; index += 1) {
        lines[index] = lines[index].replace(
            /^(createdAt|updatedAt|archivedAt): '(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)'$/,
            "$1: $2",
        );
    }
    const sourcesIndex = lines.findIndex(
        (line, index) => index > 0 && index < closing && line === "sources:",
    );
    if (sourcesIndex >= 0) {
        lines.splice(
            sourcesIndex,
            closing - sourcesIndex,
            `sources: ${JSON.stringify(unionMemorySources(entry.sources))}`,
        );
    }
    return lines.join("\n");
}

function parseTopic(raw: string): { frontmatter: TopicFrontmatter; content: string } | null {
    const match = raw.match(/^---\r?\n([\s\S]+?)\r?\n---\r?\n([\s\S]*)$/);
    if (!match) return null;
    const header = match[1];
    let data: Record<string, unknown> = {};
    try {
        data = matter(`---\n${header}\n---\n`, {}).data;
    } catch {
        // Reject malformed marked files; unmarked legacy headers need not be YAML.
        // A failed parse cannot distinguish a corrupt marked document from a
        // legacy literal, so inspect only a possible top-level codec key.
        const keys = header.matchAll(/^((?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|topicCodec))[\t ]*:/gm);
        for (const [, key] of keys) {
            try {
                if (Object.hasOwn(matter(`---\n${key}: null\n---\n`, {}).data, "topicCodec"))
                    return null;
            } catch {
                // A malformed key cannot identify the versioned codec.
            }
        }
    }
    // YAML resolves quoted/escaped marker keys. Parsing success alone must not
    // change unmarked legacy literals such as A # B, 'quoted', true or dates.
    const marked = data && Object.hasOwn(data, "topicCodec");
    if (marked) {
        if (data.topicCodec !== 1) return null;
    } else {
        const get = (key: string): string =>
            header.match(new RegExp(`^${key}:[\\t ]*([^\\r\\n]*)$`, "m"))?.[1]?.trim() ?? "";
        data = Object.fromEntries(
            ["name", "description", "type", "createdAt", "updatedAt", "archivedAt"].map((key) => [
                key,
                get(key),
            ]),
        );
        const explicit = get("explicitlyRequested");
        data.explicitlyRequested =
            explicit === "true" ? true : explicit === "false" ? false : undefined;
        try {
            data.sources = JSON.parse(get("sources"));
        } catch {
            // Legacy provenance is best-effort, independently of the topic.
        }
    }
    const text = (key: string): string => {
        const value = data[key];
        return typeof value === "string" ? value : value instanceof Date ? value.toISOString() : "";
    };
    const type = text("type");
    if (!(MEMORY_ENTRY_TYPES as readonly string[]).includes(type)) return null;
    const createdAt = text("createdAt");
    const archivedAt = text("archivedAt");
    const sources = parseSources(data.sources, marked);
    return {
        content: match[2].trim(),
        frontmatter: {
            name: text("name"),
            description: text("description"),
            type: type as MemoryEntryType,
            ...(createdAt ? { createdAt } : {}),
            updatedAt: text("updatedAt") || undefined,
            ...(archivedAt ? { archivedAt } : {}),
            ...(typeof data.explicitlyRequested === "boolean"
                ? { explicitlyRequested: data.explicitlyRequested }
                : {}),
            ...(sources.length ? { sources } : {}),
        },
    };
}

/** Parse topic metadata without filesystem identity or timestamp fallbacks. */
export function parseTopicFrontmatter(raw: string): TopicFrontmatter | null {
    return parseTopic(raw)?.frontmatter ?? null;
}

/** Decode active and archived files with identity and mtime supplied by the caller. */
export function decodeTopic(
    raw: string,
    metadata: Pick<MemoryEntry, "id" | "createdAt" | "workspaceId">,
): MemoryEntry | null {
    const parsed = parseTopic(raw);
    return parsed ? { ...metadata, ...parsed.frontmatter, content: parsed.content } : null;
}

/** Corrupt provenance must not hide an otherwise readable memory. */
function parseSources(values: unknown, marked: boolean): NonNullable<MemoryEntry["sources"]> {
    if (!Array.isArray(values)) return [];
    const sources: NonNullable<MemoryEntry["sources"]>[number][] = [];
    for (const value of values) {
        if (value === null || typeof value !== "object") continue;
        const { via, explicitlyRequested } = value;
        const scalarText = (candidate: unknown): string | undefined => {
            if (candidate instanceof Date) return candidate.toISOString();
            if (typeof candidate === "string") return candidate;
            if (marked && typeof candidate === "number" && Number.isFinite(candidate)) {
                return String(candidate);
            }
            return undefined;
        };
        const sessionId = scalarText(value.sessionId);
        const recordedAt =
            value.recordedAt instanceof Date ? value.recordedAt.toISOString() : value.recordedAt;
        const entryId = value.entryId === undefined ? undefined : scalarText(value.entryId);
        if (
            typeof sessionId !== "string" ||
            !sessionId.trim() ||
            typeof recordedAt !== "string" ||
            !Number.isFinite(Date.parse(recordedAt)) ||
            (via !== "auto" && via !== "tool") ||
            (value.entryId !== undefined && (typeof entryId !== "string" || !entryId.trim())) ||
            (explicitlyRequested !== undefined && typeof explicitlyRequested !== "boolean")
        )
            continue;
        sources.push({
            sessionId,
            recordedAt,
            via,
            ...(entryId === undefined ? {} : { entryId }),
            ...(explicitlyRequested === undefined ? {} : { explicitlyRequested }),
        });
    }
    return unionMemorySources(sources);
}
