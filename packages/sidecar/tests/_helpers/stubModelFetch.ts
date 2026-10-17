/**
 * Make model network calls fail immediately instead of reaching a provider.
 *
 * Tests that drive the real inbound path (`ingress.submit` → `session.prompt`)
 * are asserting routing, forwarding and push fan-out — not model output. Left
 * alone, the prompt resolves whatever provider key the developer's environment
 * exports and waits out real connection timeouts, which turns these suites from
 * sub-second into minutes. Registers its own before/after hooks; call once at
 * module top level.
 */
import { after, before } from "node:test";

export function stubModelFetch(): void {
    const original = globalThis.fetch;
    before(() => {
        globalThis.fetch = (async () =>
            new Response(
                JSON.stringify({
                    type: "error",
                    error: { type: "authentication_error", message: "disabled in unit tests" },
                }),
                { status: 401, headers: { "content-type": "application/json" } },
            )) as typeof fetch;
    });
    after(() => {
        globalThis.fetch = original;
    });
}
