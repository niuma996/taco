/**
 * session.* turn handlers — prompt, steer, submitAnswers, abort.
 *
 * These handlers interact with the harness turn loop and share the
 * auto-attach / compaction-wait pattern. All require ensureWorkspace.
 */

import { AgentHarnessError } from "@earendil-works/pi-agent-core";
import type {
    AbortParams,
    PromptParams,
    PromptResult,
    SteerParams,
    SubmitAnswersParams,
} from "@taco-ai/protocol";
import {
    ErrorCodes,
    sessionAbortSchema,
    sessionPromptSchema,
    sessionSteerSchema,
    sessionSubmitAnswersSchema,
} from "@taco-ai/protocol";
import { RPC } from "@taco-ai/shared";

import { createLogger } from "../../lib/logger.ts";
import type { AttachOptions } from "../../runtime/workspace.ts";
import {
    formatAskUserContextBody,
    resolveAskUserQuestions,
    wrapAskUserContext,
} from "../../tools/askUserInjectionText.ts";
import { type MethodCtx, RpcHandlerError, registerMethod } from "../methodRegistry.ts";
import { ensureAttached, requireAttached } from "./attachGuard.ts";

const log = createLogger("session:turn");

/**
 * How long a turn-starting RPC waits for an in-flight compaction to finish.
 * Sized above CompactionController's own 30s budget so the common case is
 * "wait, then proceed" rather than "reject" — a compaction that outlives this
 * is stuck, not slow.
 */
const COMPACTION_WAIT_MS = 35_000;

/**
 * Wait out an in-flight compaction before starting a turn, and refuse the turn
 * if it never finishes.
 *
 * Proceeding regardless (the previous behaviour) means calling `harness.prompt()`
 * while the harness is in its `compaction` phase, which throws
 * `AgentHarnessError("busy")` — an error the client cannot act on. Returning
 * `session_busy` instead gives callers a retryable, documented code.
 *
 * The desktop freezes its composer for the duration of a compaction, so callers
 * that reach the reject path are mostly non-desktop (IM, TUI); telling them to
 * retry beats dropping the message.
 */
async function requireCompactionSettled(
    server: MethodCtx<{ workspace: string; sessionId: string }>["server"],
    workspace: string,
    sessionId: string,
): Promise<void> {
    const settled = await server.awaitCompactionEnd(workspace, sessionId, COMPACTION_WAIT_MS);
    if (!settled) {
        throw new RpcHandlerError(
            ErrorCodes.SessionBusy,
            "compaction is still in progress for this session; retry shortly",
        );
    }
}

/**
 * Translate pi's internal busy signal into the wire-stable `session_busy`.
 *
 * `normalizeError` only preserves the code of an `RpcHandlerError`; anything
 * else is flattened to `internal` with a redacted message, which would hide a
 * transient, retryable condition behind a generic server error.
 */
function rethrowBusyAsSessionBusy(e: unknown): never {
    if (e instanceof AgentHarnessError && e.code === "busy") {
        throw new RpcHandlerError(
            ErrorCodes.SessionBusy,
            "a turn is already active for this session; retry shortly",
        );
    }
    throw e;
}

export function registerSessionTurnHandlers(): void {
    registerMethod(
        RPC.sessionPrompt,
        true,
        async ({ workspace, server, params }: MethodCtx<PromptParams>) => {
            // A `model` param applies to a not-yet-attached session (the first
            // turn of a brand-new session). An already-attached session ignores
            // it — switch those with session.setModel. Resolves through the
            // catalog so an unknown provider/model id is caught here, not later
            // inside the harness.
            const attachOpts: AttachOptions = {};
            if (params.model) {
                const model = workspace.models.getModel(params.model.provider, params.model.id);
                if (model) attachOpts.model = model;
            }
            const attached = await ensureAttached(workspace, params.sessionId, attachOpts);
            await requireCompactionSettled(server, params.workspace, params.sessionId);
            const title = params.text.slice(0, 60).replace(/\n+/g, " ").trim();
            if (title) {
                try {
                    await attached.session.appendSessionName(title);
                } catch (e) {
                    log.error("appendSessionName failed:", e);
                }
            }
            const assistantMessage = await attached
                .prompt(params.text, params.images, params.uiLocale)
                .catch(rethrowBusyAsSessionBusy);
            workspace.invalidateListCache();
            const result: PromptResult = { assistantMessage };
            return result;
        },
        { command: true, turnStart: true, schema: sessionPromptSchema },
    );

    registerMethod(
        RPC.sessionSteer,
        true,
        async ({ workspace, server, params }: MethodCtx<SteerParams>) => {
            const attached = requireAttached(workspace, params.sessionId);
            await server.awaitCompactionEnd(params.workspace, params.sessionId);
            await attached.steer(params.text, params.uiLocale);
            return null;
        },
        { command: true, schema: sessionSteerSchema },
    );

    registerMethod(
        RPC.sessionSubmitAnswers,
        true,
        async ({ workspace, server, params }: MethodCtx<SubmitAnswersParams>) => {
            const attached = await ensureAttached(workspace, params.sessionId);
            await requireCompactionSettled(server, params.workspace, params.sessionId);

            const toolName = params.toolName ?? "askUser";
            const questions = await resolveAskUserQuestions(attached, params.toolCallId, toolName);
            if (questions === null) {
                throw new RpcHandlerError(
                    ErrorCodes.InvalidState,
                    `no waiting ${toolName} tool result for toolCallId=${params.toolCallId}`,
                );
            }

            const body = formatAskUserContextBody(toolName, questions, params.answers);
            const text = wrapAskUserContext(body);
            await attached.prompt(text).catch(rethrowBusyAsSessionBusy);
            workspace.invalidateListCache();
            return null;
        },
        { command: true, turnStart: true, schema: sessionSubmitAnswersSchema },
    );

    registerMethod(
        RPC.sessionAbort,
        true,
        async ({ workspace, params }: MethodCtx<AbortParams>) => {
            const attached = workspace.getAttached(params.sessionId);
            if (!attached) return { status: "not_running" };
            await attached.abort();
            return { status: "aborted" };
        },
        { command: true, schema: sessionAbortSchema },
    );
}
