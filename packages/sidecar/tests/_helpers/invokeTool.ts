/**
 * Invoke a tool's `execute` from a test.
 *
 * pi 0.85 changed the signature to
 * `execute(toolCallId, params, onUpdate, toolContext, invocation, context)` —
 * the abort signal moved onto the trailing `Context`, and an `invocation`
 * (durable replay memos) was added. Tests care about the params and the tool
 * context; this helper supplies believable defaults for the rest so the shape
 * is defined in one place.
 */

import type { Context } from "../../src/runtime/pi/types.ts";
import { BACKGROUND_CONTEXT, withAbortSignal } from "../../src/runtime/pi/values.ts";

/** The subset of a tool that tests invoke. */
interface ExecutableTool<TParams, TResult> {
    execute(
        toolCallId: string,
        params: TParams,
        onUpdate: never,
        toolContext: never,
        invocation: never,
        context: Context,
    ): Promise<TResult>;
}

export interface InvokeToolOptions {
    toolCallId?: string;
    /** Cancellation for the call; derived onto the Context pi now reads it from. */
    signal?: AbortSignal;
    /** Streaming-update callback. Most tools ignore it. */
    onUpdate?: unknown;
}

/**
 * A stub `AgentHarnessToolInvocation`. The memo store is per-call and in-memory:
 * a tool that writes a memo can read it back within the same invocation, which
 * is the only behaviour tests rely on.
 */
function stubInvocation(toolCallId: string): unknown {
    const memos = new Map<string, unknown>();
    return {
        invocationId: toolCallId,
        operationId: `op-${toolCallId}`,
        turnId: `turn-${toolCallId}`,
        getMemo: async (name: string) => memos.get(name),
        setMemo: async (name: string, value: unknown) => {
            if (value === undefined) memos.delete(name);
            else memos.set(name, value);
        },
    };
}

/** Call `tool.execute` with pi 0.85's argument shape. */
export function invokeTool<TParams, TResult>(
    tool: ExecutableTool<TParams, TResult>,
    params: TParams,
    toolContext: unknown,
    options: InvokeToolOptions = {},
): Promise<TResult> {
    const toolCallId = options.toolCallId ?? "tc-1";
    const context =
        options.signal === undefined
            ? BACKGROUND_CONTEXT
            : withAbortSignal(options.signal, BACKGROUND_CONTEXT);
    return tool.execute(
        toolCallId,
        params,
        (options.onUpdate ?? undefined) as never,
        toolContext as never,
        stubInvocation(toolCallId) as never,
        context,
    );
}
