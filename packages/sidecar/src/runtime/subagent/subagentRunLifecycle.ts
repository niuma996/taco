import { asSessionId, type SessionId } from "@taco-ai/protocol";

export interface SubagentController {
    controller: AbortController;
    parentSessionId: SessionId;
}

interface RunScopeRequest {
    sessionId: string;
    parentSessionId: SessionId;
    controller?: AbortController;
    signal?: AbortSignal;
}

interface RunScope {
    controller: AbortController;
    release(): void;
}

/** Own cancellation from setup through settlement, including nested background scopes. */
export class SubagentRunLifecycle {
    private readonly scopes = new Map<SubagentController, Set<symbol>>();
    private readonly waiters = new Map<SubagentController, Set<() => void>>();
    private stopping = false;

    constructor(private readonly controllers = new Map<string, SubagentController>()) {}

    acquire(request: RunScopeRequest): RunScope {
        const controller = request.controller ?? new AbortController();
        let entry = this.controllers.get(request.sessionId);
        if (
            entry &&
            (entry.controller !== controller || entry.parentSessionId !== request.parentSessionId)
        ) {
            throw new Error("This agent is already running.");
        }
        if (!entry) {
            entry = { controller, parentSessionId: request.parentSessionId };
            this.controllers.set(request.sessionId, entry);
        }
        const token = Symbol();
        const leases = this.scopes.get(entry) ?? new Set<symbol>();
        leases.add(token);
        this.scopes.set(entry, leases);
        const signal = request.signal;
        const follow = () => controller.abort(signal?.reason);
        const linked = signal && signal !== controller.signal;
        if (linked) {
            if (signal.aborted) follow();
            else signal.addEventListener("abort", follow, { once: true });
        }
        if (this.stopping) controller.abort();
        return {
            controller,
            release: () => {
                if (!leases.delete(token)) return;
                if (linked) signal.removeEventListener("abort", follow);
                if (leases.size > 0) return;
                this.scopes.delete(entry);
                if (this.controllers.get(request.sessionId) === entry) {
                    this.controllers.delete(request.sessionId);
                }
                this.notify(entry);
            },
        };
    }

    async run<T>(
        request: RunScopeRequest,
        execute: (controller: AbortController) => Promise<T>,
    ): Promise<T> {
        const scope = this.acquire(request);
        try {
            return await execute(scope.controller);
        } finally {
            scope.release();
        }
    }

    abort(sessionId: string, parentSessionId?: SessionId): boolean {
        const entry = this.controllers.get(sessionId);
        if (!entry || entry.controller.signal.aborted) return false;
        if (parentSessionId !== undefined && entry.parentSessionId !== parentSessionId)
            return false;
        entry.controller.abort();
        return true;
    }

    async stopChildrenOf(parentSessionId: SessionId, timeoutMs = 5_000): Promise<SessionId[]> {
        const running = [...this.controllers.entries()].filter(
            ([, entry]) => entry.parentSessionId === parentSessionId,
        );
        if (running.length === 0) return [];
        const callbacks: Array<{ entry: SubagentController; done: () => void }> = [];
        const stopped = running.map(
            ([, entry]) =>
                new Promise<void>((done) => {
                    const waiters = this.waiters.get(entry) ?? new Set();
                    waiters.add(done);
                    this.waiters.set(entry, waiters);
                    callbacks.push({ entry, done });
                }),
        );
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            for (const [, entry] of running) entry.controller.abort();
            await Promise.race([
                Promise.all(stopped),
                new Promise<void>((done) => {
                    timer = setTimeout(done, timeoutMs);
                }),
            ]);
        } finally {
            if (timer !== undefined) clearTimeout(timer);
            for (const { entry, done } of callbacks) {
                const waiters = this.waiters.get(entry);
                waiters?.delete(done);
                if (waiters?.size === 0) this.waiters.delete(entry);
            }
        }
        return running
            .filter(([id, entry]) => this.controllers.get(id) === entry)
            .map(([id]) => asSessionId(id));
    }

    stop(): void {
        this.stopping = true;
        for (const entry of this.controllers.values()) entry.controller.abort();
    }

    private notify(entry: SubagentController): void {
        const waiters = this.waiters.get(entry);
        this.waiters.delete(entry);
        for (const done of waiters ?? []) done();
    }
}
