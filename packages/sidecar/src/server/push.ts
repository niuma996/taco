/**
 * Push frame serialization — turns internal runtime events into ServerPush frames.
 *
 * Sole responsibility: a single entry point for push-frame construction and
 * id generation, so the server no longer needs to call randomUUID() and
 * assemble ServerPush by hand.
 */

import { randomUUID } from "node:crypto";
import {
    type CommandPermissionRequestedParams,
    type PushMethodName,
    PushMethods,
    type ServerPush,
    SIDECAR_PROTOCOL_VERSION,
    type SidecarHelloParams,
    type ToolCallEndParams,
    type ToolCallStartParams,
    type ToolCallUpdateParams,
    type WorkspaceId,
} from "@taco-ai/protocol";
import { redactUnknown } from "../extensions/builtin/outputRedaction/index.ts";

/**
 * Scrub tool-call `args` before pushing to the desktop UI.
 *
 * `args` is forwarded on `tool_execution_start` *before* the tool runs —
 * the outputRedaction hook only sees `tool_result.content`, so a literal
 * key in a bash command would otherwise reach the desktop shell view raw.
 * Delegates to `redactUnknown`, which handles serialization + warn-on-failure.
 * If `args` is not JSON-serializable, `redactUnknown` logs a warning and
 * passes `args` through unchanged.
 */
function redactToolArgs(args: unknown): [unknown, boolean] {
    return redactUnknown(args);
}

/** Options for constructing a workspace/session-dimensioned push */
export interface PushEventOptions {
    method: string;
    workspace: WorkspaceId;
    session?: string;
    seq?: number;
    /** Session type — the client routes main vs subagent session based on this (see ServerPush.sessionKind) */
    sessionKind?: "main" | "subagent";
    params?: unknown;
    /** Explicit push id (for dedupe; defaults to randomUUID) */
    id?: string;
}

/**
 * Scrub a command permission request before pushing to the desktop UI.
 *
 * Mirrors redactToolArgs: the command string may contain API keys, bearer
 * tokens, or other secrets, so we redact before it reaches the event stream.
 */
export function redactCommandPermissionRequest(
    request: unknown,
): [CommandPermissionRequestedParams, boolean] {
    return redactUnknown(request) as [CommandPermissionRequestedParams, boolean];
}

/** Build a server-side push frame (auto-assigns id) */
export function makePushFrame<TParams = unknown>(opts: PushEventOptions): ServerPush<TParams> {
    return {
        id: opts.id ?? randomUUID(),
        method: opts.method,
        workspace: opts.workspace,
        session: opts.session,
        seq: opts.seq,
        sessionKind: opts.sessionKind,
        params: opts.params as TParams,
    };
}

/** Liveness-only hello frame (fired once on spawn). Capability negotiation
 *  lives on the `initialize` RPC. */
export function makeHelloFrame(
    version: string,
    pid: number,
    instanceId = randomUUID(),
): ServerPush<SidecarHelloParams> {
    return makePushFrame<SidecarHelloParams>({
        method: PushMethods.Hello,
        workspace: "*",
        params: {
            version,
            pid,
            instanceId,
            protocol: SIDECAR_PROTOCOL_VERSION,
        },
    });
}

/**
 * Splits the three `tool_execution_*` AgentHarnessEvent variants from the
 * harness into named push frames. Non-tool events return undefined — the
 * caller falls back to the generic session.event path.
 *
 * Returned id is the toolCallId so the client-side dispatcher can dedupe.
 */
export function toToolCallPush(event: unknown):
    | {
          method: PushMethodName;
          params: ToolCallStartParams | ToolCallUpdateParams | ToolCallEndParams;
          id: string;
      }
    | undefined {
    if (!event || typeof event !== "object") return undefined;
    const e = event as { type?: unknown };
    if (
        e.type !== "tool_execution_start" &&
        e.type !== "tool_execution_update" &&
        e.type !== "tool_execution_end"
    ) {
        return undefined;
    }
    const ee = event as {
        type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end";
        toolCallId: string;
        ts?: number;
        toolName?: string;
        args?: unknown;
        partialResult?: unknown;
        result?: { content?: Array<{ type?: string; text?: string }>; details?: unknown };
        isError?: boolean;
    };
    if (typeof ee.toolCallId !== "string") return undefined;
    const ts = typeof ee.ts === "number" ? ee.ts : Date.now();
    if (ee.type === "tool_execution_start") {
        const [redactedArgs] = redactToolArgs(ee.args);
        return {
            method: PushMethods.ToolCallStart,
            params: {
                ts,
                toolCallId: ee.toolCallId,
                toolName: ee.toolName ?? "tool",
                args: redactedArgs,
            },
            id: ee.toolCallId,
        };
    }
    if (ee.type === "tool_execution_update") {
        return {
            method: PushMethods.ToolCallUpdate,
            params: {
                ts,
                toolCallId: ee.toolCallId,
                partialResult: ee.partialResult,
            },
            id: ee.toolCallId,
        };
    }
    return {
        method: PushMethods.ToolCallEnd,
        params: {
            ts,
            toolCallId: ee.toolCallId,
            toolName: ee.toolName ?? "tool",
            isError: ee.isError === true,
            result: ee.result,
        },
        id: ee.toolCallId,
    };
}
