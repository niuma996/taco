/**
 * useSessionSettings — optimistic settings owned by a workspace/session pair,
 * plus model choices owned by a workspace/draft pair before session creation.
 */

import { asSessionId, asWorkspaceId, type ThinkingLevel } from "@taco-ai/protocol";
import { useCallback, useRef, useState } from "react";
import type { ModelSelection } from "../components/settings/ModelPicker";
import type { TacoClient } from "../lib/clients/tacoClient.ts";
import { defaultThinkingLevelForNewSession, getGlobalConfig } from "../lib/globalConfig";
import type { PushNotificationOptions } from "../lib/notifications";

/** An omitted draft id preserves the single-draft API within each workspace. */
export interface DraftTarget {
    workspace: string;
    draftId?: string;
}

export interface SessionTarget extends DraftTarget {
    /** Undefined means the target is a draft rather than an attached session. */
    sessionId?: string;
}

function sessionKey(workspace: string, sessionId: string): string {
    return JSON.stringify([workspace, sessionId]);
}

function draftKey({ workspace, draftId }: DraftTarget): string {
    return JSON.stringify([workspace, draftId ?? null]);
}

/** Synchronous snapshots also handle multiple picks before React renders again. */
function useVersionedMap<V>() {
    const [values, setValues] = useState<Record<string, V>>({});
    const current = useRef<Record<string, V>>({});
    const versions = useRef(new Map<string, symbol>());

    function read(key: string): V | undefined {
        return current.current[key];
    }

    function write(key: string, next: V | undefined): symbol {
        const token = Symbol();
        versions.current.set(key, token);
        const updated = { ...current.current };
        if (next === undefined) delete updated[key];
        else updated[key] = next;
        current.current = updated;
        setValues(updated);
        return token;
    }

    async function apply(key: string, next: V, rpc: () => Promise<unknown>, label: string) {
        const previous = read(key);
        const token = write(key, next);
        try {
            await rpc();
        } catch (err) {
            console.error(`[taco] ${label} failed`, err);
            // A newer pick (even an equal value) owns the key after its write.
            if (versions.current.get(key) === token) write(key, previous);
            throw err;
        }
    }

    return { values, read, write, apply };
}

/** Level + model to open a brand-new session with, resolved before its id exists. */
export interface NewSessionDefaults {
    initialLevel: ThinkingLevel;
    /** Staged pick from the ModelMenu, or null to let the server choose. */
    initialModel: ModelSelection | null;
}

export interface UseSessionSettingsApi {
    /** Keys encode [workspace, sessionId]; use isThinkingSuppressed for lookups. */
    sessionLevels: Record<string, ThinkingLevel>;
    /** Thinking level displayed for the current session. */
    activeLevel: ThinkingLevel | null;
    /** Model displayed for the current session; the staged pick when there is no session. */
    activeModel: ModelSelection | null;
    /** Defaults to the workspace captured by this render. */
    isThinkingSuppressed: (sid: string, workspace?: string) => boolean;
    setSessionLevel: (next: ThinkingLevel, target?: SessionTarget) => Promise<void>;
    setSessionModel: (next: ModelSelection, target?: SessionTarget) => Promise<void>;
    /** Resolve the level + model a new session should be created with. */
    newSessionDefaults: (target?: DraftTarget) => NewSessionDefaults;
    /** Adopt defaults in their original workspace, consuming only the original staged pick. */
    adoptNewSession: (
        sessionId: string,
        defaults: NewSessionDefaults,
        target?: DraftTarget,
    ) => void;
    /** Drop only the targeted draft's staged model. */
    clearStagedModel: (target?: DraftTarget) => void;
}

export interface UseSessionSettingsOptions {
    client: TacoClient;
    activeCwd: string;
    /** Currently attached session, or undefined on a fresh pre-send workspace. */
    activeSession: string | undefined;
    activeDraftId?: string;
    pushNotification: (msg: string, opts?: PushNotificationOptions) => void;
}

export function useSessionSettings({
    client,
    activeCwd,
    activeSession,
    activeDraftId,
    pushNotification,
}: UseSessionSettingsOptions): UseSessionSettingsApi {
    const levels = useVersionedMap<ThinkingLevel>();
    const models = useVersionedMap<ModelSelection>();
    const stagedModels = useVersionedMap<ModelSelection>();
    const activeTarget: SessionTarget = {
        workspace: activeCwd,
        sessionId: activeSession,
        draftId: activeDraftId,
    };

    const isThinkingSuppressed = useCallback(
        (sid: string, workspace = activeCwd): boolean =>
            (levels.values[sessionKey(workspace, sid)] ??
                defaultThinkingLevelForNewSession(getGlobalConfig().global)) === "off",
        [levels.values, activeCwd],
    );

    async function setSessionLevel(next: ThinkingLevel, target = activeTarget): Promise<void> {
        const { workspace, sessionId } = target;
        if (!sessionId) return;
        try {
            await levels.apply(
                sessionKey(workspace, sessionId),
                next,
                () =>
                    client.sessionSetThinkingLevel({
                        workspace: asWorkspaceId(workspace),
                        sessionId: asSessionId(sessionId),
                        level: next,
                    }),
                "sessionSetThinkingLevel",
            );
        } catch (err) {
            pushNotification(`Thinking level change failed: ${(err as Error).message}`);
        }
    }

    async function setSessionModel(next: ModelSelection, target = activeTarget): Promise<void> {
        const { workspace, sessionId } = target;
        if (!sessionId) {
            stagedModels.write(draftKey(target), next);
            return;
        }
        try {
            await models.apply(
                sessionKey(workspace, sessionId),
                next,
                () =>
                    client.sessionSetModel({
                        workspace: asWorkspaceId(workspace),
                        sessionId: asSessionId(sessionId),
                        provider: next.provider,
                        modelId: next.id,
                    }),
                "sessionSetModel",
            );
        } catch (err) {
            pushNotification(`Model change failed: ${(err as Error).message}`);
        }
    }

    const activeKey = activeSession ? sessionKey(activeCwd, activeSession) : undefined;
    return {
        sessionLevels: levels.values,
        activeLevel: activeKey
            ? (levels.values[activeKey] ??
              defaultThinkingLevelForNewSession(getGlobalConfig().global))
            : null,
        activeModel: activeKey
            ? (models.values[activeKey] ?? null)
            : (stagedModels.values[draftKey(activeTarget)] ?? null),
        isThinkingSuppressed,
        setSessionLevel,
        setSessionModel,
        newSessionDefaults: (target = activeTarget) => ({
            initialLevel: defaultThinkingLevelForNewSession(getGlobalConfig().global),
            initialModel: stagedModels.read(draftKey(target)) ?? null,
        }),
        adoptNewSession: (sessionId, { initialLevel, initialModel }, target = activeTarget) => {
            const key = sessionKey(target.workspace, sessionId);
            levels.write(key, initialLevel);
            if (initialModel) models.write(key, initialModel);
            // Creation may finish after a new model was picked in the same draft.
            const stagedKey = draftKey(target);
            if (stagedModels.read(stagedKey) === initialModel)
                stagedModels.write(stagedKey, undefined);
        },
        clearStagedModel: (target = activeTarget) =>
            stagedModels.write(draftKey(target), undefined),
    };
}
