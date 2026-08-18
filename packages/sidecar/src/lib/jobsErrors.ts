/**
 * JobsScopeError — thrown by JobsController when an actor-attempting
 * operation violates the IM / IDE scope rule. Carries a wire-friendly
 * error code so `jobs.*` RPC handlers can map it to RpcHandlerError
 * without leaking implementation details.
 *
 * Code values:
 *  - `not_found` : the job doesn't exist OR exists but is out of scope;
 *                  the same code is returned either way to avoid leaking
 *                  existence to out-of-scope callers.
 *  - `forbidden` : caller is identified (actor present) but lacks access.
 *                  Currently only used by `update` where the existing
 *                  job's scope matters even when the new payload's
 *                  workspace hasn't changed.
 */

export class JobsScopeError extends Error {
    constructor(
        public readonly code: "not_found" | "forbidden",
        message: string,
    ) {
        super(message);
        this.name = "JobsScopeError";
    }
}
