import { RpcHandlerError } from "../server/methodRegistry.ts";

/** Conservative ASCII subset that is safe to embed in a file basename
 *  without quoting and cannot escape its containing directory.
 *  Anchored start/end + length 1..64 to reject empty, `.`, `..`, slashes,
 *  spaces, control chars, shell metacharacters and overlong inputs. */
const SAFE_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export class InvalidJobIdError extends Error {
    constructor(id: string, reason: string) {
        super(`invalid job id ${JSON.stringify(id)} (${reason})`);
        this.name = "InvalidJobIdError";
    }
}

export function isSafeJobId(id: string): boolean {
    return typeof id === "string" && SAFE_JOB_ID.test(id);
}

export function assertSafeJobId(id: string): void {
    if (typeof id !== "string" || id.length === 0) {
        throw new InvalidJobIdError(String(id), "must be a non-empty string");
    }
    if (!SAFE_JOB_ID.test(id)) {
        throw new InvalidJobIdError(id, "job id must match [A-Za-z0-9][A-Za-z0-9_-]{0,63}");
    }
}

/** RPC-boundary variant: throws `RpcHandlerError("invalid_params", ...)`
 *  on rejection so the wire response carries the correct error code.
 *  Use this from any RPC handler — direct `assertSafeJobId` is fine for
 *  internal callers (JobStore, Scheduler) where a plain Error is
 *  appropriate. */
export function safeJobId(id: string): void {
    try {
        assertSafeJobId(id);
    } catch (e) {
        if (e instanceof InvalidJobIdError) {
            throw new RpcHandlerError("invalid_params", e.message);
        }
        throw e;
    }
}
