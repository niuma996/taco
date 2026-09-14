/**
 * Outbound request identity for provider streams — tags the `streamOptions`
 * handed to `AgentHarness` with the sidecar version.
 *
 * Split out of `AttachedSession` because it is a pure function over
 * (streamOptions, models, provider) with no session state; `create()` is its
 * only caller. The non-stream callers (`providerModels`, `MemoryExtractorImpl`,
 * `factExtractor`) share the header vocabulary through
 * `runtimeResources.tacoRequestHeaders()`.
 */

import type { AgentHarnessStreamOptions, Models } from "../pi/types.ts";
import { sidecarVersion } from "../runtimeResources.ts";

/**
 * Tag provider requests with the sidecar version.
 *
 * `user-agent: taco/<version>` — set on every NON-OAuth provider. OAuth
 * providers (Anthropic OAuth in particular) need their
 * `claude-cli/<version>` identity preserved: pi-ai's openai / anthropic
 * SDKs read `this.constructor.name` for the default UA, and overriding
 * with `taco/<version>` would lose Claude Code's OAuth beta features.
 * The OAuth check uses `checkAuth` (never triggers a token refresh)
 * rather than `getAuth`.
 *
 * `x-taco-sidecar-version: <version>` — set on EVERY provider. It's
 * metadata, not identity, so it never conflicts with the OAuth UA. On
 * an OAuth call it's the only taco tag that survives, which is enough
 * to attribute the request to a taco version in the provider's logs.
 *
 * If `checkAuth` cannot classify the provider we skip the UA override
 * but still attach the version header — the version is safe; the UA
 * is the identity-bearing field.
 */
export async function withTacoUserAgent(
    streamOptions: AgentHarnessStreamOptions,
    models: Models,
    provider: string,
): Promise<AgentHarnessStreamOptions> {
    let skipUserAgent = false;
    try {
        const authCheck = await models.checkAuth(provider);
        skipUserAgent = authCheck?.type === "oauth";
    } catch {
        // Credential-store failures must not block attach; safe to drop
        // the UA override (we don't know if it would override an OAuth
        // identity) but keep the version header — it's metadata only.
        skipUserAgent = true;
    }

    const version = sidecarVersion();
    // Strip any caller-supplied `user-agent` on the OAuth path. pi-ai
    // hardcodes `claude-cli/<version>` for Anthropic OAuth to keep Claude
    // Code's OAuth beta features enabled, and a caller's UA in
    // `streamOptions.headers` would otherwise survive the spread and
    // override it (we are the last merge layer before pi-ai's defaults).
    const callerHeaders = { ...streamOptions.headers };
    if (skipUserAgent) delete callerHeaders["user-agent"];

    const tags: Record<string, string> = {
        "x-taco-sidecar-version": version,
        ...(skipUserAgent ? {} : { "user-agent": `taco/${version}` }),
    };

    return {
        ...streamOptions,
        headers: {
            ...callerHeaders,
            ...tags,
        },
    };
}
