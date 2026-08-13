/**
 * session.* runtime handlers — setModel, setThinkingLevel, compact, contextInfo.
 *
 * All require an already-attached session (via requireAttached). They
 * mutate attached session state but do not initiate a model turn.
 */

import type {
    SessionCompactParams,
    SessionContextInfoParams,
    SessionSetThinkingLevelParams,
    SetModelParams,
} from "@taco-ai/protocol";
import {
    sessionCompactSchema,
    sessionContextInfoSchema,
    sessionSetModelSchema,
    sessionSetThinkingLevelSchema,
} from "@taco-ai/protocol";
import { RPC } from "@taco-ai/shared";
import { type MethodCtx, registerMethod } from "../methodRegistry.ts";
import { requireAttached } from "./attachGuard.ts";

export function registerSessionRuntimeHandlers(): void {
    registerMethod(
        RPC.sessionSetModel,
        true,
        async ({ workspace, params }: MethodCtx<SetModelParams>) => {
            requireAttached(workspace, params.sessionId);
            await workspace.setSessionModel(params.sessionId, params.provider, params.modelId);
            return { switchedTo: { provider: params.provider, modelId: params.modelId } };
        },
        { command: true, schema: sessionSetModelSchema },
    );

    registerMethod(
        RPC.sessionSetThinkingLevel,
        true,
        async ({ workspace, params }: MethodCtx<SessionSetThinkingLevelParams>) => {
            requireAttached(workspace, params.sessionId);
            await workspace.setSessionThinkingLevel(params.sessionId, params.level);
            return { level: params.level };
        },
        { command: true, schema: sessionSetThinkingLevelSchema },
    );

    registerMethod(
        RPC.sessionCompact,
        true,
        async ({ workspace, params }: MethodCtx<SessionCompactParams>) => {
            const attached = requireAttached(workspace, params.sessionId);
            return await attached.compact(params.customInstructions);
        },
        { command: true, schema: sessionCompactSchema },
    );

    registerMethod(
        RPC.sessionContextInfo,
        true,
        async ({ workspace, params }: MethodCtx<SessionContextInfoParams>) => {
            const attached = requireAttached(workspace, params.sessionId);
            return await attached.getContextInfo();
        },
        { schema: sessionContextInfoSchema },
    );
}
