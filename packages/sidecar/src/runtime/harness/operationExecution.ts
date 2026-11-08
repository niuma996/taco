import { AsyncLocalStorage } from "node:async_hooks";
import { harnessContext } from "../../lib/harnessContext.ts";
import type { AgentLane, Context, ImageContent } from "../pi/types.ts";
import { isBusyError, toHarnessError } from "./harnessErrors.ts";

export interface PromptOperation {
    readonly operationId: string;
}

interface ManagedOperation extends PromptOperation {
    readonly sessionId: string;
    readonly beforeAccept: (operationId: string) => Promise<void>;
    readonly afterAccept: (operationId: string) => Promise<void>;
    claimed?: boolean;
}

const executions = new AsyncLocalStorage<ManagedOperation>();

/** Scope one admission to its execution session; nested tools cannot inherit its identity. */
export function withManagedOperation<T>(
    operation: ManagedOperation,
    run: () => Promise<T>,
): Promise<T> {
    return executions.run(operation, run);
}

export function claimManagedOperation(sessionId: string): ManagedOperation | undefined {
    const operation = executions.getStore();
    if (!operation || operation.claimed || operation.sessionId !== sessionId) return undefined;
    operation.claimed = true;
    return operation;
}

/** Query before accept: the harness itself permits reusing an already settled id. */
export async function executePromptOperation(
    lane: AgentLane,
    operation: PromptOperation,
    text: string,
    images: ImageContent[] | undefined,
    context: Context,
    managed?: ManagedOperation,
) {
    const result = await lane.getResult(operation.operationId, harnessContext);
    if (result) return result;
    const current = await lane.inspectExecution(harnessContext);
    if (current.current?.id !== operation.operationId) {
        await managed?.beforeAccept(operation.operationId);
        const accepted = await lane.accept(
            { kind: "prompt", operationId: operation.operationId, prompt: text, images },
            context,
        );
        if (!accepted.ok) {
            if (managed && isBusyError(accepted.error)) managed.claimed = false;
            throw toHarnessError("session.accept", accepted.error);
        }
    }
    await managed?.afterAccept(operation.operationId);
    const driven = await lane.drive(
        { operationId: operation.operationId, waitForRetry: true },
        context,
    );
    if (!driven.ok) throw toHarnessError("session.drive", driven.error);
    if (driven.value.kind === "settled") return driven.value.outcome;
    if (driven.value.reason === "deferred")
        return {
            operationId: operation.operationId,
            status: "suspended" as const,
            deferred: driven.value.deferred,
        };
    throw new Error("operation returned an unwaited retry");
}
