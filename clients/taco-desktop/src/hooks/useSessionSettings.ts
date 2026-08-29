/**
 * useSessionSettings — per-session thinking level and model selection.
 *
 * Both are optimistic maps keyed by sessionId that live outside the workspace
 * reducer: they are user preferences the server echoes back, not workspace
 * state, and a failed RPC must roll one key back without touching messages.
 *
 * The hook also owns the "staged model" slot — a model picked while the
 * workspace has no session yet (fresh session before its first send). Without
 * it a ModelMenu change on a blank session is silently dropped.
 */

import type { ThinkingLevel } from "@taco-ai/protocol";
import { type Dispatch, type SetStateAction, useCallback, useState } from "react";
import type { ModelSelection } from "../components/settings/ModelPicker";
import { defaultThinkingLevelForNewSession, getGlobalConfig } from "../lib/globalConfig";
import type { TacoClient } from "../lib/tacoClientTauri.ts";

/**
 * Optimistic per-session setter: write `next` under `sid`, await `rpc`, and on
 * throw roll back to the previous value if any (else drop the key). Re-throws
 * after rollback so the caller can show its own error UI (banner / toast).
 * Centralizes the hadPrev/prev/destructure dance so model/thinking rollback
 * rules don't drift between call sites.
 */
async function applyOptimistic<K extends string, V>(
    map: Record<K, V>,
    setter: Dispatch<SetStateAction<Record<K, V>>>,
    sid: K,
    next: V,
    rpc: () => Promise<void>,
    label: string,
): Promise<void> {
    const hadPrev = Object.hasOwn(map, sid);
    const prev = map[sid];
    setter((m) => ({ ...m, [sid]: next }));
    try {
        await rpc();
    } catch (err) {
        console.error(`[taco] ${label} failed`, err);
        setter((m) => {
            if (hadPrev) return { ...m, [sid]: prev as V };
            const { [sid]: _drop, ...rest } = m;
            void _drop;
            return rest as Record<K, V>;
        });
        throw err;
    }
}

/** Level + model to open a brand-new session with, resolved before its id exists. */
export interface NewSessionDefaults {
    initialLevel: ThinkingLevel;
    /** Staged pick from the ModelMenu, or null to let the server choose. */
    initialModel: ModelSelection | null;
}

export interface UseSessionSettingsApi {
    sessionLevels: Record<string, ThinkingLevel>;
    /** Thinking level displayed for the current session. */
    activeLevel: ThinkingLevel | null;
    /** Model displayed for the current session; the staged pick when there is no session. */
    activeModel: ModelSelection | null;
    /** Whether streaming thinking_* sub-events should be hidden for `sid`. */
    isThinkingSuppressed: (sid: string) => boolean;
    setSessionLevel: (next: ThinkingLevel) => Promise<void>;
    setSessionModel: (next: ModelSelection) => Promise<void>;
    /** Resolve the level + model a new session should be created with. */
    newSessionDefaults: () => NewSessionDefaults;
    /** Record the defaults under the id the server just allocated, clearing the staged model. */
    adoptNewSession: (sessionId: string, defaults: NewSessionDefaults) => void;
    /** Drop the staged model — the session it was picked for was abandoned. */
    clearStagedModel: () => void;
}

export interface UseSessionSettingsOptions {
    client: TacoClient;
    activeCwd: string;
    /** Currently attached session, or undefined on a fresh pre-send workspace. */
    activeSession: string | undefined;
    setErrorBanner: (msg: string | null) => void;
}

export function useSessionSettings({
    client,
    activeCwd,
    activeSession,
    setErrorBanner,
}: UseSessionSettingsOptions): UseSessionSettingsApi {
    const [sessionLevels, setSessionLevels] = useState<Record<string, ThinkingLevel>>({});
    const [sessionModels, setSessionModels] = useState<Record<string, ModelSelection>>({});
    // State (not a ref) so the ModelMenu re-renders when the staged choice changes.
    const [stagedModel, setStagedModel] = useState<ModelSelection | null>(null);

    const isThinkingSuppressed = useCallback(
        (sid: string): boolean =>
            sessionLevels[sid] !== undefined
                ? sessionLevels[sid] === "off"
                : defaultThinkingLevelForNewSession(getGlobalConfig().global) === "off",
        [sessionLevels],
    );

    async function setSessionLevel(next: ThinkingLevel): Promise<void> {
        if (!activeSession) return;
        try {
            await applyOptimistic(
                sessionLevels,
                setSessionLevels,
                activeSession,
                next,
                async () => {
                    await client.sessionSetThinkingLevel(activeCwd, activeSession, next);
                },
                "sessionSetThinkingLevel",
            );
        } catch (err) {
            setErrorBanner(`Thinking level change failed: ${(err as Error).message}`);
        }
    }

    async function setSessionModel(next: ModelSelection): Promise<void> {
        if (!activeSession) {
            // No session yet: stage the choice so the lazy-create path applies it.
            setStagedModel(next);
            return;
        }
        try {
            await applyOptimistic(
                sessionModels,
                setSessionModels,
                activeSession,
                next,
                async () => {
                    await client.sessionSetModel(activeCwd, activeSession, next.provider, next.id);
                },
                "sessionSetModel",
            );
        } catch (err) {
            setErrorBanner(`Model change failed: ${(err as Error).message}`);
        }
    }

    return {
        sessionLevels,
        activeLevel: activeSession
            ? (sessionLevels[activeSession] ??
              defaultThinkingLevelForNewSession(getGlobalConfig().global))
            : null,
        activeModel: activeSession ? (sessionModels[activeSession] ?? null) : stagedModel,
        isThinkingSuppressed,
        setSessionLevel,
        setSessionModel,
        newSessionDefaults: () => ({
            initialLevel: defaultThinkingLevelForNewSession(getGlobalConfig().global),
            initialModel: stagedModel,
        }),
        adoptNewSession: (sessionId, { initialLevel, initialModel }) => {
            setSessionLevels((m) => ({ ...m, [sessionId]: initialLevel }));
            // The staged model only applies to this session's first attach;
            // later switches go through session.setModel.
            setStagedModel(null);
            if (initialModel) setSessionModels((m) => ({ ...m, [sessionId]: initialModel }));
        },
        clearStagedModel: () => setStagedModel(null),
    };
}
