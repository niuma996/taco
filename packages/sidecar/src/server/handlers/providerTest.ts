/**
 * provider.testConnection — top-level RPC that sends one minimal chat turn to
 * a provider and reports whether it answered.
 *
 * The probe goes through the same pi streaming path a session uses (the
 * provider's own protocol implementation, auth resolution and headers), so a
 * pass means the key, endpoint, protocol and model id all work together —
 * something `provider.listModels` cannot show, since many relays answer
 * `/models` while rejecting chat, or the reverse.
 *
 * Two param shapes:
 * - `{ providerId, modelId, apiKey? }` — a saved provider. The key comes from
 *   the process ProviderKeyStore unless `apiKey` overrides it (a key typed in
 *   the detail panel but not yet saved). pi's auth layer lets an explicit
 *   apiKey win over the stored credential, so nothing has to be written.
 * - `{ baseUrl, api, apiKey, modelId }` — the create-custom form. A throwaway
 *   custom provider is built from the form values; it is never registered.
 *
 * Each probe runs in its own `createModels()` collection so it can neither
 * read nor mutate the workspace catalog. Cost: a few input tokens and at most
 * MAX_TOKENS output tokens per click.
 */

import type { Api, AssistantMessage, Model, Provider } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai";
import type {
    ProviderTestConnectionFailureReason,
    ProviderTestConnectionParams,
    ProviderTestConnectionResult,
} from "@taco-ai/protocol";
import { ErrorCodes, providerTestConnectionSchema } from "@taco-ai/protocol";
import { RPC } from "@taco-ai/shared";
import { buildCustomProvider } from "../../runtime/models/customProvider.ts";
import { tacoRequestHeaders } from "../../runtime/runtimeResources.ts";
import { type MethodCtx, RpcHandlerError, registerMethod } from "../methodRegistry.ts";

/** Overall probe budget. Long enough for a cold relay, short enough to feel like a test. */
const TIMEOUT_MS = 20_000;
/** Small reply cap — enough for "pong" or a short sentence on reasoning models. */
const MAX_TOKENS = 16;
/** Characters of the reply echoed back to the UI. */
const REPLY_PREVIEW_CHARS = 80;
/** The probe prompt. Deliberately trivial; any non-error reply counts as a pass. */
const PROBE_PROMPT = "Reply with the single word: pong";

/** Throwaway provider id for the create-form branch — never registered anywhere. */
const PROBE_PROVIDER_ID = "custom:connection-test";

/** Sends the probe. Injectable so tests never touch the network. */
export type ProbeFn = (
    provider: Provider,
    model: Model<Api>,
    apiKey: string | undefined,
    signal: AbortSignal,
) => Promise<AssistantMessage>;

export function registerProviderTestHandlers(deps: { probe?: ProbeFn } = {}): void {
    const probe = deps.probe ?? performProbe;
    registerMethod(
        RPC.providerTestConnection,
        false,
        async ({
            server,
            params,
        }: MethodCtx<ProviderTestConnectionParams>): Promise<ProviderTestConnectionResult> => {
            const target = resolveTarget(server, params);
            if ("error" in target) {
                throw new RpcHandlerError(ErrorCodes.InvalidParams, target.error);
            }
            const { provider, model, apiKey } = target;

            const started = Date.now();
            const elapsed = () => Date.now() - started;
            let message: AssistantMessage;
            try {
                message = await probe(provider, model, apiKey, AbortSignal.timeout(TIMEOUT_MS));
            } catch (e) {
                return failure(classifyThrown(e), describeThrown(e), elapsed());
            }

            // pi reports upstream failures on the message rather than throwing.
            if (message.stopReason === "error" || message.stopReason === "aborted") {
                const text = message.errorMessage ?? "the provider returned an error";
                const reason = message.stopReason === "aborted" ? "timeout" : classifyMessage(text);
                return failure(reason, text, elapsed());
            }

            return {
                ok: true,
                latencyMs: elapsed(),
                model: message.responseModel ?? model.id,
                reply: replyPreview(message),
            };
        },
        { schema: providerTestConnectionSchema },
    );
}

type Target = { provider: Provider; model: Model<Api>; apiKey: string | undefined };

/** Normalize the two param shapes into a provider + model to probe, or an error message. */
function resolveTarget(
    server: MethodCtx<ProviderTestConnectionParams>["server"],
    params: ProviderTestConnectionParams,
): Target | { error: string } {
    if (!params || typeof params !== "object") return { error: "params are required" };
    const modelId = typeof params.modelId === "string" ? params.modelId.trim() : "";
    if (!modelId) return { error: "modelId is required" };

    if ("providerId" in params) {
        const { providerId } = params;
        if (typeof providerId !== "string" || providerId.trim() === "") {
            return { error: "providerId is required" };
        }
        const provider = server.buildProvider?.(providerId);
        if (!provider) return { error: `unknown provider: ${providerId}` };
        const typed = typeof params.apiKey === "string" ? params.apiKey.trim() : "";
        const apiKey = typed || server.providerKeyStore.get(providerId);
        if (!apiKey) return { error: `no API key configured for provider: ${providerId}` };
        const model = provider.getModels().find((m) => m.id === modelId);
        // A model id not in the list (e.g. typed but not yet added) still gets
        // probed — it inherits the provider's protocol from its first model.
        const resolved = model ?? cloneModel(provider, modelId);
        if (!resolved)
            return { error: `provider ${providerId} has no models to infer a protocol from` };
        return { provider, model: resolved, apiKey };
    }

    const { baseUrl, api, apiKey } = params;
    if (typeof baseUrl !== "string" || baseUrl.trim() === "")
        return { error: "baseUrl is required" };
    if (api !== "chatcomplete" && api !== "response" && api !== "anthropic") {
        return { error: `unsupported api: ${String(api)}` };
    }
    if (typeof apiKey !== "string" || apiKey.trim() === "") return { error: "apiKey is required" };
    const provider = buildCustomProvider({
        id: PROBE_PROVIDER_ID,
        name: "Connection test",
        api,
        baseUrl: baseUrl.trim(),
        models: [{ id: modelId }],
    });
    const model = provider.getModels()[0];
    if (!model) return { error: "failed to build a probe model" };
    return { provider, model, apiKey: apiKey.trim() };
}

/** Clone the provider's first model under a new id so it streams via the same protocol. */
function cloneModel(provider: Provider, modelId: string): Model<Api> | undefined {
    const template = provider.getModels()[0];
    return template ? { ...template, id: modelId, name: modelId } : undefined;
}

/**
 * Production probe: an isolated Models collection holding only this provider,
 * so the request runs through pi's normal auth + header merge. An explicit
 * `apiKey` wins over the (empty) credential store in pi's auth resolution.
 */
export async function performProbe(
    provider: Provider,
    model: Model<Api>,
    apiKey: string | undefined,
    signal: AbortSignal,
): Promise<AssistantMessage> {
    const models = createModels();
    models.setProvider(provider);
    return models.completeSimple(
        model,
        {
            messages: [{ role: "user", content: PROBE_PROMPT, timestamp: Date.now() }],
        },
        {
            apiKey,
            signal,
            maxTokens: MAX_TOKENS,
            // A test should report the first failure, not hide it behind retries.
            maxRetries: 0,
            timeoutMs: TIMEOUT_MS,
            headers: tacoRequestHeaders(),
        },
    );
}

function failure(
    reason: ProviderTestConnectionFailureReason,
    message: string,
    latencyMs: number,
): ProviderTestConnectionResult {
    return { ok: false, reason, message: truncate(message, 300), latencyMs };
}

/** First text of the reply, trimmed for display. Empty for thinking-only replies. */
function replyPreview(message: AssistantMessage): string {
    const text = message.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
    return truncate(text, REPLY_PREVIEW_CHARS);
}

function truncate(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Map an upstream error text to a reason. pi surfaces SDK errors as text, so
 * this matches on the HTTP status the SDKs embed ("401 ...", "status 404").
 * Unmatched text falls through to `error` and the UI shows the raw message.
 */
export function classifyMessage(text: string): ProviderTestConnectionFailureReason {
    const t = text.toLowerCase();
    // Transport errors first: Node's "getaddrinfo ENOTFOUND host" contains
    // "not found" and would otherwise read as a missing model.
    if (
        /econnrefused|enotfound|econnreset|ehostunreach|fetch failed|getaddrinfo|socket hang up/.test(
            t,
        )
    ) {
        return "network";
    }
    if (
        /\b(401|403)\b/.test(t) ||
        /unauthori[sz]ed|(invalid|incorrect).*api.?key|authentication|permission/.test(t)
    ) {
        return "auth";
    }
    if (/\b404\b/.test(t) || /not.?found|does not exist|no such model|unknown model/.test(t)) {
        return "not-found";
    }
    if (/\b429\b/.test(t) || /rate.?limit|quota|too many requests/.test(t)) return "rate-limited";
    if (/timed? ?out|timeout/.test(t)) return "timeout";
    return "error";
}

function classifyThrown(e: unknown): ProviderTestConnectionFailureReason {
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError"))
        return "timeout";
    return classifyMessage(describeThrown(e));
}

function describeThrown(e: unknown): string {
    if (e instanceof Error) return e.message || e.name;
    return String(e);
}
