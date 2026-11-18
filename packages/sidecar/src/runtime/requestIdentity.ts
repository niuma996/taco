/**
 * Outbound request identity — the headers the sidecar presents to model
 * providers on every LLM request.
 *
 * One decision point for both request paths: the harness stream options
 * (`runtime/models/requestHeaders.ts`) and the one-shot calls that bypass the
 * harness (memory extraction, session titles, provider probes).
 *
 * The identity is derived state: it is rebuilt from the global config on every
 * `refreshConfiguration()` rather than watched for changes.
 */

import { sidecarVersion } from "./runtimeResources.ts";

export interface RequestIdentity {
    /**
     * User-configured User-Agent. `undefined` means "unset" — the default
     * `taco/<version>` identity is used.
     */
    userAgent?: string;
}

let current: RequestIdentity = {};

/** Replace the process-wide identity. Called on every config refresh. */
export function setRequestIdentity(next: RequestIdentity): void {
    current = { userAgent: next.userAgent?.trim() || undefined };
}

export function getRequestIdentity(): RequestIdentity {
    return current;
}

/**
 * Build the identity headers for one outbound model request.
 *
 * - A custom User-Agent replaces `taco/<version>` and suppresses
 *   `x-taco-sidecar-version` — that header names taco outright, so keeping
 *   it would defeat the point of a custom identity.
 * - Without a custom User-Agent the default identity is sent:
 *   `user-agent: taco/<version>` plus the version header.
 * - OAuth providers get no `user-agent` at all: pi-ai sends its own
 *   `claude-cli/<version>` identity for Anthropic OAuth, and overriding it
 *   costs the Claude Code beta features. The version header still follows
 *   the same rule as above.
 */
export function buildRequestHeaders(opts?: { oauth?: boolean }): Record<string, string> {
    const version = sidecarVersion();
    const custom = current.userAgent;
    if (opts?.oauth) {
        return custom ? {} : { "x-taco-sidecar-version": version };
    }
    if (custom) return { "user-agent": custom };
    return {
        "user-agent": `taco/${version}`,
        "x-taco-sidecar-version": version,
    };
}
