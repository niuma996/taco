/**
 * Prompt-cache fingerprint — hash the request prefix so a cache miss can name
 * which field changed (system / tools / messages[0] / tool order).
 *
 * Anthropic-compatible providers key the prefix from system + tools + the
 * first user message. A 128-token `cacheRead` on a later turn is almost
 * always one of those three moving, not TTL. This module does not change
 * the payload; it only logs hashes.
 *
 * State is keyed by `sessionId:lane` and capped (LRU) so a burst of
 * short-lived subagents cannot grow the map unboundedly — or evict the
 * parent session that is still taking turns.
 */

import { createHash } from "node:crypto";
import { createLogger } from "../../lib/logger.ts";

const log = createLogger("promptCache");

const HASH_LEN = 16;
/** Cap on tracked sessions. Eviction is LRU (re-insert on hit), not insertion order. */
export const MAX_TRACKED_FINGERPRINT_KEYS = 16;

export interface PromptCacheFingerprint {
    readonly systemHash: string;
    readonly toolsHash: string;
    readonly perToolHashes: Readonly<Record<string, string>>;
    readonly toolNames: readonly string[];
    readonly messages0Role: string;
    readonly messages0Hash: string;
    readonly messageCount: number;
}

export interface PromptCacheBreak {
    readonly systemChanged: boolean;
    readonly toolsChanged: boolean;
    readonly changedToolSchemas: readonly string[];
    readonly addedTools: readonly string[];
    readonly removedTools: readonly string[];
    readonly toolOrderChanged: boolean;
    readonly messages0Changed: boolean;
}

interface TrackedState {
    fingerprint: PromptCacheFingerprint;
    callCount: number;
}

const previousByKey = new Map<string, TrackedState>();

export function hashText(value: string): string {
    return createHash("sha256").update(value).digest("hex").slice(0, HASH_LEN);
}

function contentText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return JSON.stringify(content ?? "");
    return (content as Array<{ text?: string; type?: string }>)
        .map((b) => (typeof b?.text === "string" ? b.text : JSON.stringify(b)))
        .join("");
}

function toolKey(tool: { name?: unknown; description?: unknown; parameters?: unknown }): string {
    return JSON.stringify({
        name: tool.name ?? "",
        description: tool.description ?? "",
        parameters: tool.parameters ?? {},
    });
}

/** Pull the cache-relevant prefix out of a `before_payload` body. */
export function fingerprintPayload(payload: unknown): PromptCacheFingerprint {
    const body = (payload ?? {}) as {
        system?: unknown;
        messages?: Array<{ role?: string; content?: unknown }>;
        tools?: Array<{ name?: unknown; description?: unknown; parameters?: unknown }>;
    };
    const system =
        typeof body.system === "string"
            ? body.system
            : body.system === undefined
              ? ""
              : JSON.stringify(body.system);
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const perToolHashes: Record<string, string> = {};
    const toolNames: string[] = [];
    for (const [i, tool] of tools.entries()) {
        const name =
            typeof tool.name === "string" && tool.name.length > 0 ? tool.name : `__idx_${i}`;
        toolNames.push(name);
        perToolHashes[name] = hashText(toolKey(tool));
    }
    const first = body.messages?.[0];
    return {
        systemHash: hashText(system),
        toolsHash: hashText(JSON.stringify(tools.map(toolKey))),
        perToolHashes,
        toolNames,
        messages0Role: typeof first?.role === "string" ? first.role : "",
        messages0Hash: hashText(contentText(first?.content)),
        messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
    };
}

function diffFingerprints(
    prev: PromptCacheFingerprint,
    next: PromptCacheFingerprint,
): PromptCacheBreak {
    const prevSet = new Set(prev.toolNames);
    const nextSet = new Set(next.toolNames);
    const addedTools = next.toolNames.filter((n) => !prevSet.has(n));
    const removedTools = prev.toolNames.filter((n) => !nextSet.has(n));
    const changedToolSchemas: string[] = [];
    if (next.toolsHash !== prev.toolsHash) {
        for (const name of next.toolNames) {
            if (!prevSet.has(name)) continue;
            if (next.perToolHashes[name] !== prev.perToolHashes[name])
                changedToolSchemas.push(name);
        }
    }
    const sameSet = addedTools.length === 0 && removedTools.length === 0;
    const toolOrderChanged =
        sameSet &&
        (prev.toolNames.length !== next.toolNames.length ||
            prev.toolNames.some((n, i) => n !== next.toolNames[i]));
    return {
        systemChanged: next.systemHash !== prev.systemHash,
        toolsChanged: next.toolsHash !== prev.toolsHash,
        changedToolSchemas,
        addedTools,
        removedTools,
        toolOrderChanged,
        messages0Changed:
            next.messages0Hash !== prev.messages0Hash || next.messages0Role !== prev.messages0Role,
    };
}

function formatBreak(breakInfo: PromptCacheBreak): string {
    const parts: string[] = [];
    if (breakInfo.systemChanged) parts.push("sys");
    if (breakInfo.messages0Changed) parts.push("msg0");
    if (breakInfo.toolsChanged) parts.push("tools");
    if (breakInfo.toolOrderChanged) parts.push("order");
    if (breakInfo.addedTools.length > 0) parts.push(`added=${breakInfo.addedTools.join(",")}`);
    if (breakInfo.removedTools.length > 0)
        parts.push(`removed=${breakInfo.removedTools.join(",")}`);
    if (breakInfo.changedToolSchemas.length > 0) {
        parts.push(`schema=${breakInfo.changedToolSchemas.join(",")}`);
    }
    return parts.join(",") || "-";
}

function evictIfNeeded(): void {
    while (previousByKey.size >= MAX_TRACKED_FINGERPRINT_KEYS) {
        const oldest = previousByKey.keys().next().value;
        if (oldest === undefined) break;
        previousByKey.delete(oldest);
    }
}

function touch(key: string, state: TrackedState): void {
    // Map iteration is insertion order. Delete+set moves `key` to the
    // newest slot so a live parent is not evicted by a burst of
    // short-lived subagent keys.
    previousByKey.delete(key);
    previousByKey.set(key, state);
}

/**
 * Compare `payload` against the last call for `key`, log one line, and
 * remember the new fingerprint. `key` is typically `sessionId:lane`.
 */
export function recordPromptCacheFingerprint(
    key: string,
    payload: unknown,
): PromptCacheBreak | null {
    const fingerprint = fingerprintPayload(payload);
    const prev = previousByKey.get(key);
    if (!prev) {
        evictIfNeeded();
        previousByKey.set(key, { fingerprint, callCount: 1 });
        log.info("prefix", {
            key,
            call: 1,
            sys: fingerprint.systemHash,
            tools: fingerprint.toolsHash,
            msg0: fingerprint.messages0Hash,
            n: fingerprint.messageCount,
            break: "base",
        });
        return null;
    }
    const breakInfo = diffFingerprints(prev.fingerprint, fingerprint);
    prev.fingerprint = fingerprint;
    prev.callCount += 1;
    touch(key, prev);
    log.info("prefix", {
        key,
        call: prev.callCount,
        sys: fingerprint.systemHash,
        tools: fingerprint.toolsHash,
        msg0: fingerprint.messages0Hash,
        n: fingerprint.messageCount,
        break: formatBreak(breakInfo),
    });
    return breakInfo;
}

/** Test helper — drop all tracked keys. */
export function resetPromptCacheFingerprints(): void {
    previousByKey.clear();
}
