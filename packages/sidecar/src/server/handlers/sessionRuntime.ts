/**
 * session.* runtime handlers — setModel, setThinkingLevel, compact, contextInfo.
 *
 * All require an already-attached session (via requireAttached). They
 * mutate attached session state but do not initiate a model turn.
 */

import { registerMethod } from "../methodRegistry.ts";
import { requireAttached } from "./attachGuard.ts";

export function registerSessionRuntimeHandlers(): void {
    registerMethod(
        "sessionSetModel",
        true,
        async ({ workspace, params }) => {
            requireAttached(workspace, params.sessionId);
            await workspace.setSessionModel(params.sessionId, params.provider, params.modelId);
            return { switchedTo: { provider: params.provider, modelId: params.modelId } };
        },
        { command: true },
    );

    registerMethod(
        "sessionSetThinkingLevel",
        true,
        async ({ workspace, params }) => {
            requireAttached(workspace, params.sessionId);
            await workspace.setSessionThinkingLevel(params.sessionId, params.level);
            return { level: params.level };
        },
        { command: true },
    );

    registerMethod(
        "sessionCompact",
        true,
        async ({ workspace, params }) => {
            const attached = requireAttached(workspace, params.sessionId);
            return await attached.compact(params.customInstructions);
        },
        { command: true },
    );

    registerMethod("sessionContextInfo", true, async ({ workspace, params }) => {
        const attached = requireAttached(workspace, params.sessionId);
        return await attached.getContextInfo();
    });
}
