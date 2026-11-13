import { AsyncLocalStorage } from "node:async_hooks";

const callers = new AsyncLocalStorage<{ workspace: string; sessionId: string }>();

/** Internal tool scope; external and timer-driven invocations keep completion semantics. */
export function withJobCaller<T>(
    caller: { workspace: string; sessionId: string },
    run: () => Promise<T>,
): Promise<T> {
    return callers.run(caller, run);
}

export function isJobCaller(workspace: string, sessionId: string): boolean {
    const caller = callers.getStore();
    return caller?.workspace === workspace && caller.sessionId === sessionId;
}
