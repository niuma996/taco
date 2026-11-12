import type { CommandPermissionRequest, SessionSnapshot } from "@taco-ai/protocol";
import type { QueuedUiItem, UiMessage } from "./chatUtils";

export type SessionExecution = "unknown" | "idle" | "running";
export type SessionSync = "current" | "recovering" | "incomplete";
export type BackgroundSubagentState = "running" | "completed" | "error" | "aborted";
export interface SubagentSpawnedEntry {
    subSessionId: string;
    agentType: string;
    parentToolCallId: string;
}
export interface SessionState {
    messages: UiMessage[];
    askUserPending: Record<string, true>;
    agentToolPending: Record<string, true>;
    backgroundSubagents: Record<string, BackgroundSubagentState>;
    backgroundRunIds: Record<string, string>;
    execution: SessionExecution;
    sync: SessionSync;
    kind: "main" | "subagent";
    historyLoaded: boolean;
    truncated: boolean;
    cacheBytes: number;
    lastAccess: number;
    revision: number;
    executionRevision?: number;
    operation?: NonNullable<SessionSnapshot["runtime"]>["operation"];
    historyRequestRevision?: number;
    messageVersions: Record<string, number>;
}

interface SessionWorkspace {
    activeSession?: string;
    sessionStatesById?: Record<string, SessionState>;
    messages: UiMessage[];
    askUserPending: Record<string, true>;
    agentToolPending: Record<string, true>;
    backgroundSubagents: Record<string, BackgroundSubagentState>;
    sessionInteractions?: Record<
        string,
        { messages: UiMessage[]; askUserPending: Record<string, true> }
    >;
    pendingBySessionId: Record<string, boolean>;
    queuedBySessionId: Record<string, QueuedUiItem[]>;
    pendingCommandPermissions: Record<string, CommandPermissionRequest>;
    childMessagesBySubSessionId: Record<string, UiMessage[]>;
    childHistoryLoaded: Record<string, UiMessage[]>;
}

export const SESSION_CACHE_MAX_IDLE = 10;
export const SESSION_CACHE_BYTE_BUDGET = 8 * 1024 * 1024;
export const SESSION_CACHE_ACTIVE_BYTE_BUDGET = 2 * 1024 * 1024;
const emptyMessages: UiMessage[] = [];
const emptyPending: Record<string, true> = {};
const emptyBackground: Record<string, BackgroundSubagentState> = {};
const transcriptMessageBytes = new WeakMap<UiMessage, number>();
const transcriptEncoder = new TextEncoder();

export function createSessionState(): SessionState {
    return {
        messages: [],
        askUserPending: {},
        agentToolPending: {},
        backgroundSubagents: {},
        backgroundRunIds: {},
        execution: "unknown",
        sync: "recovering",
        kind: "main",
        historyLoaded: false,
        truncated: false,
        cacheBytes: 0,
        lastAccess: 0,
        revision: 0,
        messageVersions: {},
    };
}

/** Canonical lookup; legacy roots are accepted only until their first reducer transition. */
export function getSessionState(
    ws: SessionWorkspace | undefined,
    sid: string,
): SessionState | undefined {
    if (!ws) return undefined;
    if (ws.sessionStatesById !== undefined) return ws.sessionStatesById[sid];
    const interaction = ws.activeSession === sid ? ws : ws.sessionInteractions?.[sid];
    const child = ws.childMessagesBySubSessionId[sid] ?? ws.childHistoryLoaded[sid];
    if (!interaction && !child && !(sid in ws.pendingBySessionId)) return undefined;
    return {
        ...createSessionState(),
        ...(interaction
            ? { messages: interaction.messages, askUserPending: interaction.askUserPending }
            : {}),
        ...(ws.activeSession === sid
            ? { agentToolPending: ws.agentToolPending, backgroundSubagents: ws.backgroundSubagents }
            : {}),
        ...(child
            ? {
                  messages: child,
                  kind: "subagent" as const,
                  historyLoaded: sid in ws.childHistoryLoaded,
              }
            : {}),
        execution:
            ws.pendingBySessionId[sid] === undefined
                ? "unknown"
                : ws.pendingBySessionId[sid]
                  ? "running"
                  : "idle",
    };
}

/** A complete transcript can be reused without a history read; execution may still be unknown. */
export function hasSessionCache(ws: SessionWorkspace | undefined, sid: string): boolean {
    const session = getSessionState(ws, sid);
    return session?.sync === "current" && !session.truncated;
}

export function normalizeSessionStates<T extends SessionWorkspace>(ws: T): T {
    if (ws.sessionStatesById !== undefined) return ws;
    const ids = new Set([
        ...Object.keys(ws.sessionInteractions ?? {}),
        ...Object.keys(ws.pendingBySessionId),
        ...Object.keys(ws.childMessagesBySubSessionId),
        ...Object.keys(ws.childHistoryLoaded),
        ...(ws.activeSession ? [ws.activeSession] : []),
    ]);
    let sessions: Record<string, SessionState> = ws.sessionStatesById ?? {};
    for (const sid of ids) {
        if (sessions[sid]) continue;
        const session = getSessionState(ws, sid);
        if (session)
            sessions = {
                ...sessions,
                [sid]: { ...session, cacheBytes: transcriptBytes(session.messages) },
            };
    }
    return { ...ws, sessionStatesById: sessions };
}

/** Compatibility properties are reads over canonical state, never separately updated transcripts. */
export function projectSessionState<T extends SessionWorkspace>(ws: T): T {
    const projected = { ...ws };
    const active = () =>
        projected.activeSession
            ? projected.sessionStatesById?.[projected.activeSession]
            : undefined;
    Object.defineProperties(projected, {
        messages: {
            enumerable: true,
            configurable: true,
            get: () => active()?.messages ?? emptyMessages,
        },
        askUserPending: {
            enumerable: true,
            configurable: true,
            get: () => active()?.askUserPending ?? emptyPending,
        },
        agentToolPending: {
            enumerable: true,
            configurable: true,
            get: () => active()?.agentToolPending ?? emptyPending,
        },
        backgroundSubagents: {
            enumerable: true,
            configurable: true,
            get: () => active()?.backgroundSubagents ?? emptyBackground,
        },
        sessionInteractions: {
            enumerable: true,
            configurable: true,
            get: () =>
                Object.fromEntries(
                    Object.entries(projected.sessionStatesById ?? {})
                        .filter(([sid, s]) => sid !== projected.activeSession && s.kind === "main")
                        .map(([sid, s]) => [sid, s]),
                ),
        },
        childMessagesBySubSessionId: {
            enumerable: true,
            configurable: true,
            get: () =>
                Object.fromEntries(
                    Object.entries(projected.sessionStatesById ?? {})
                        .filter(([, s]) => s.kind === "subagent")
                        .map(([sid, s]) => [sid, s.messages]),
                ),
        },
        childHistoryLoaded: {
            enumerable: true,
            configurable: true,
            get: () =>
                Object.fromEntries(
                    Object.entries(projected.sessionStatesById ?? {})
                        .filter(([, s]) => s.kind === "subagent" && s.historyLoaded)
                        .map(([sid, s]) => [sid, s.messages]),
                ),
        },
    });
    return projected;
}

/** Exact JSON UTF-8 size; published messages and their nested data must remain immutable. */
export function transcriptBytes(messages: UiMessage[]): number {
    // Brackets and commas are ASCII; per-message JSON preserves escaping and nested payloads.
    let bytes = 2 + Math.max(0, messages.length - 1);
    for (const message of messages) {
        let size = transcriptMessageBytes.get(message);
        if (size === undefined) {
            size = transcriptEncoder.encode(JSON.stringify(message)).byteLength;
            transcriptMessageBytes.set(message, size);
        }
        bytes += size;
    }
    return bytes;
}

export function updateSessionMessages(session: SessionState, messages: UiMessage[]): SessionState {
    if (session.messages === messages) return session;
    const revision = session.revision + 1;
    const previous = new Map(session.messages.map((m) => [messageKey(m), m]));
    const messageVersions: Record<string, number> = {};
    for (const message of messages) {
        const key = messageKey(message);
        messageVersions[key] =
            previous.get(key) === message ? (session.messageVersions[key] ?? 0) : revision;
    }
    return {
        ...session,
        messages,
        revision,
        messageVersions,
        cacheBytes: transcriptBytes(messages),
    };
}

// History and live streams use different entry ids for the same role/timestamp.
function messageKey(message: UiMessage): string {
    return `${message.kind}:${message.kind === "assistant" || message.kind === "user" ? (message.ts ?? message.id) : message.id}`;
}

/** Only messages changed after the history request may override an overlapping history entry. */
export function mergeSessionHistory(session: SessionState, history: UiMessage[]): SessionState {
    const live = new Map(session.messages.map((m) => [messageKey(m), m]));
    const seen = new Set<string>();
    const messages = history.map((message) => {
        const key = messageKey(message);
        seen.add(key);
        const cached = live.get(key);
        if (session.truncated && cached && message.text.endsWith(cached.text)) {
            if (message.kind === "assistant" && cached.kind === "assistant") {
                return {
                    ...message,
                    tools: (message.tools ?? []).map((tool) => {
                        const liveTool = (cached.tools ?? []).find((t) => t.id === tool.id);
                        const trimmed = (
                            liveTool?.details as { cacheTruncated?: boolean } | undefined
                        )?.cacheTruncated;
                        return liveTool &&
                            !trimmed &&
                            (session.messageVersions[key] ?? 0) >
                                (session.historyRequestRevision ?? 0)
                            ? liveTool
                            : tool;
                    }),
                };
            }
            return message;
        }
        return cached && (session.messageVersions[key] ?? 0) > (session.historyRequestRevision ?? 0)
            ? cached
            : message;
    });
    for (const message of session.messages) {
        const changedSinceRead = (session.messageVersions[messageKey(message)] ?? 0) > 0;
        const legacyInteraction =
            message.kind === "assistant" &&
            (message.tools ?? []).some((t) => session.askUserPending[t.id]);
        if (!seen.has(messageKey(message)) && (changedSinceRead || legacyInteraction))
            messages.push(message);
    }
    const merged = updateSessionMessages(
        session,
        messages.length === history.length && messages.every((m, i) => m === history[i])
            ? history
            : messages,
    );
    const toolIds = new Set(
        history.flatMap((m) => (m.kind === "assistant" ? (m.tools ?? []).map((t) => t.id) : [])),
    );
    const askUserPending: Record<string, true> = {};
    const retainedIds = new Set(
        merged.messages.flatMap((m) =>
            m.kind === "assistant" ? (m.tools ?? []).map((t) => t.id) : [],
        ),
    );
    for (const [id] of Object.entries(session.askUserPending))
        if (!toolIds.has(id) && retainedIds.has(id)) askUserPending[id] = true;
    for (const message of merged.messages) {
        if (message.kind !== "assistant") continue;
        for (const tool of message.tools ?? []) {
            const details = tool.details as { waiting?: boolean; answers?: unknown } | undefined;
            if (
                (tool.name === "askUser" || tool.name === "planExit") &&
                details?.waiting === true &&
                !details.answers
            )
                askUserPending[tool.id] = true;
        }
    }
    const truncationCovered =
        !session.truncated ||
        session.messages.every((message) =>
            history.some(
                (h) => messageKey(h) === messageKey(message) && h.text.endsWith(message.text),
            ),
        );
    return {
        ...merged,
        askUserPending,
        sync: truncationCovered ? "current" : "incomplete",
        historyLoaded: true,
        truncated: !truncationCovered,
        historyRequestRevision: undefined,
    };
}

export function enforceSessionCache<T extends SessionWorkspace>(ws: T): T {
    let sessions: Record<string, SessionState> = ws.sessionStatesById ?? {};
    const set = (sid: string, s: SessionState | undefined) => {
        if (sessions === ws.sessionStatesById) sessions = { ...sessions };
        if (s) sessions[sid] = s;
        else delete sessions[sid];
    };
    const protectedSession = (sid: string, s: SessionState) =>
        sid === ws.activeSession ||
        s.execution !== "idle" ||
        s.sync !== "current" ||
        Object.keys(s.askUserPending).length > 0 ||
        Object.keys(s.agentToolPending).length > 0 ||
        Object.values(s.backgroundSubagents).includes("running") ||
        !!ws.queuedBySessionId[sid]?.length ||
        Object.values(ws.pendingCommandPermissions).some(
            (r) => r.sessionId === sid || r.displaySessionId === sid,
        );
    const idle = Object.entries(sessions)
        .filter(([sid, s]) => !protectedSession(sid, s))
        .sort((a, b) => b[1].lastAccess - a[1].lastAccess);
    for (const [sid] of idle.slice(SESSION_CACHE_MAX_IDLE)) set(sid, undefined);
    let bytes = Object.values(sessions).reduce((sum, s) => sum + s.cacheBytes, 0);
    for (const [sid, s] of idle.slice(0, SESSION_CACHE_MAX_IDLE).reverse()) {
        if (bytes <= SESSION_CACHE_BYTE_BUDGET) break;
        set(sid, undefined);
        bytes -= s.cacheBytes;
    }
    // Protected sessions share the total budget; loss remains visible to recovery.
    const protectedCount = Object.entries(sessions).filter(([sid, session]) =>
        protectedSession(sid, session),
    ).length;
    const tailBudget = Math.min(
        SESSION_CACHE_ACTIVE_BYTE_BUDGET,
        Math.floor(SESSION_CACHE_BYTE_BUDGET / Math.max(1, protectedCount)),
    );
    for (const [sid, session] of Object.entries(sessions)) {
        if (!protectedSession(sid, session) || session.cacheBytes <= tailBudget) continue;
        let messages = session.messages;
        let size = session.cacheBytes;
        while (messages.length > 1 && size > tailBudget) {
            messages = messages.slice(Math.max(1, Math.floor(messages.length / 2)));
            size = transcriptBytes(messages);
        }
        if (size > tailBudget) {
            const last = messages.at(-1);
            if (!last) continue;
            const text = last.text.slice(-Math.floor(tailBudget / 16));
            const base = { id: last.id, ts: last.ts, text };
            messages = [
                last.kind === "assistant"
                    ? {
                          ...base,
                          kind: "assistant",
                          thinking: [],
                          tools: (last.tools ?? []).slice(-16).map((tool) =>
                              new TextEncoder().encode(JSON.stringify(tool)).byteLength >
                              tailBudget / 64
                                  ? {
                                        id: tool.id,
                                        name: tool.name,
                                        status: tool.status,
                                        args: {},
                                        resultText: tool.resultText?.slice(
                                            -Math.floor(tailBudget / 256),
                                        ),
                                        details: { cacheTruncated: true },
                                    }
                                  : tool,
                          ),
                      }
                    : { ...base, kind: last.kind },
            ];
        }
        set(sid, {
            ...updateSessionMessages(session, messages),
            truncated: true,
        });
    }
    return sessions === ws.sessionStatesById ? ws : { ...ws, sessionStatesById: sessions };
}
