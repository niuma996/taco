import type { SessionTarget } from "@taco-ai/protocol";
import type { UiMessage } from "./chatUtils";
import type { WorkspaceState } from "./workspaceReducer";

export function conversationActivityKey(target: SessionTarget): string {
    return JSON.stringify([target.workspace, target.sessionId]);
}

/** Canonical runtime state is authoritative; approvals can be displayed on a parent chat. */
export function getConversationActivity(ws: WorkspaceState | undefined, sid: string) {
    const session = ws?.sessionStatesById?.[sid];
    const interaction =
        ws?.sessionStatesById === undefined
            ? ws?.activeSession === sid
                ? ws
                : ws?.sessionInteractions?.[sid]
            : undefined;
    const messages = session?.messages ?? interaction?.messages ?? [];
    const latestVisible = [...messages]
        .reverse()
        .find((message) => message.kind === "system" || message.kind !== "tool");
    return {
        running: session
            ? session.execution === "running" ||
              Object.keys(session.agentToolPending).length > 0 ||
              Object.values(session.backgroundSubagents).includes("running")
            : Boolean(ws?.pendingBySessionId[sid]),
        waiting: Boolean(
            Object.keys(session?.askUserPending ?? interaction?.askUserPending ?? {}).length > 0 ||
                Object.values(ws?.pendingCommandPermissions ?? {}).some(
                    (request) => request.sessionId === sid || request.displaySessionId === sid,
                ),
        ),
        incomplete: session?.sync === "incomplete",
        error: latestVisible?.kind === "system" && latestVisible.text.startsWith("[session.error]"),
    };
}

export function summarizeConversationActivity(
    items: ReadonlyArray<
        Pick<
            ReturnType<typeof getConversationActivity>,
            "running" | "waiting" | "incomplete" | "error"
        > & { unread?: boolean }
    >,
) {
    return {
        running: items.some((item) => item.running),
        waiting: items.some((item) => item.waiting),
        incomplete: items.some((item) => item.incomplete),
        error: items.some((item) => item.error),
        unread: items.some((item) => item.unread),
    };
}

interface MessageFingerprint {
    timestamp: number;
    hash: number;
    assistantContentHash?: number;
    wasLive?: boolean;
}

export interface ConversationWatermark {
    initialized: boolean;
    latestTimestamp: number;
    fingerprints: Map<string, MessageFingerprint>;
    observed: WeakSet<UiMessage[]>;
}

export function createConversationWatermark(): ConversationWatermark {
    return {
        initialized: false,
        latestTimestamp: 0,
        fingerprints: new Map(),
        observed: new WeakSet(),
    };
}

// Keep only small hashes for the recent tail; never retain transcript strings or arrays.
function fingerprint(message: UiMessage, includeTools = true): number {
    const content = JSON.stringify([
        message.text,
        message.kind === "assistant" ? message.thinking.map((block) => block.thinking) : undefined,
        includeTools && message.kind === "assistant"
            ? message.tools.map((tool) => [tool.id, tool.name, tool.resultText])
            : undefined,
    ]);
    let hash = 2166136261;
    for (let i = 0; i < content.length; i++)
        hash = Math.imul(hash ^ content.charCodeAt(i), 16777619);
    return hash;
}

/** A first history/snapshot load establishes a baseline; a first live incoming message is activity.
 * The timestamp watermark survives eviction and the bounded fingerprint tail recognizes streaming
 * changes at the same timestamp. Old history repairs and status-only changes never become unread.
 */
export function observeConversationMessages(
    watermark: ConversationWatermark,
    messages: UiMessage[],
    historyLoaded: boolean,
    startedAt: number,
    isRunning = false,
): boolean {
    const recent = messages
        .filter((message) => message.kind !== "system" && Number.isFinite(message.ts))
        .slice(-32);
    const liveAssistant = isRunning
        ? [...recent].reverse().find((message) => message.kind === "assistant")
        : undefined;
    const liveKey = liveAssistant ? `assistant:${liveAssistant.ts}` : undefined;
    if (liveKey) {
        const previous = watermark.fingerprints.get(liveKey);
        if (previous) previous.wasLive = true;
    }
    if (watermark.observed.has(messages)) return false;
    watermark.observed.add(messages);
    let changed = false;
    const fingerprints = new Map(watermark.fingerprints);
    const grouped = new Map<string, MessageFingerprint>();
    for (const message of recent) {
        // Live and persisted IDs differ; role and original timestamp survive recovery.
        // Fold timestamp collisions together so replay cannot compare one sibling to another.
        const key = `${message.kind}:${message.ts}`;
        const hash = Math.imul(
            (grouped.get(key)?.hash ?? 2166136261) ^ fingerprint(message),
            16777619,
        );
        const assistantContentHash =
            message.kind === "assistant"
                ? Math.imul(
                      (grouped.get(key)?.assistantContentHash ?? 2166136261) ^
                          fingerprint(message, false),
                      16777619,
                  )
                : undefined;
        grouped.set(key, {
            timestamp: message.ts,
            hash,
            assistantContentHash,
            wasLive: key === liveKey || watermark.fingerprints.get(key)?.wasLive,
        });
    }
    for (const [key, current] of grouped) {
        const previous = watermark.fingerprints.get(key);
        const recentActivity =
            current.timestamp > startedAt &&
            (watermark.initialized || !historyLoaded) &&
            (current.timestamp > watermark.latestTimestamp ||
                (previous !== undefined && previous.hash !== current.hash));
        // An ongoing reply keeps its original pre-launch timestamp. Compare its established
        // text/thinking baseline even after it finishes; historical tool repairs are excluded.
        const continuedReply =
            previous !== undefined &&
            current.wasLive &&
            previous.assistantContentHash !== current.assistantContentHash;
        if (recentActivity || continuedReply) changed = true;
        fingerprints.set(key, current);
    }
    watermark.fingerprints = new Map(
        [...fingerprints].sort((a, b) => b[1].timestamp - a[1].timestamp).slice(0, 32),
    );
    for (const message of recent)
        watermark.latestTimestamp = Math.max(watermark.latestTimestamp, message.ts);
    watermark.initialized = true;
    return changed;
}
