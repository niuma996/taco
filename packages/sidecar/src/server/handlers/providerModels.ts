/**
 * provider.listModels — top-level RPC that fetches the remote model catalog
 * so the settings UI can suggest ids.
 *
 * Two param shapes:
 * - `{ baseUrl, api, apiKey }` — custom-provider form; the key travels in
 *   params and is never persisted, logged, or echoed back.
 * - `{ providerId }` — already-saved provider (built-in or custom); baseUrl/api
 *   resolve via the registered provider and the key comes from the process
 *   ProviderKeyStore, so plaintext keys never cross the wire.
 *
 * Protocol coverage: every protocol shares one model catalog — OpenAI-family
 * ({baseUrl}/models, Bearer) and Anthropic ({baseUrl}/v1/models, x-api-key).
 * The `api` value only selects auth headers and the path prefix; it does not
 * gate discovery. Anthropic also honours a baseUrl already ending in /v1.
 * Response shape is parsed tolerantly by `extractModelIds`.
 */

import type {
    CustomProviderApi,
    ProviderListModelsParams,
    ProviderListModelsResult,
} from "@taco-ai/protocol";
import { ErrorCodes, providerListModelsSchema } from "@taco-ai/protocol";
import { RPC } from "@taco-ai/shared";
import { tacoRequestHeaders } from "../../runtime/runtimeResources.ts";
import { type MethodCtx, RpcHandlerError, registerMethod } from "../methodRegistry.ts";

const HTTP_TIMEOUT_MS = 5_000;
/** Anthropic Messages version header required by api.anthropic.com/v1/models. */
const ANTHROPIC_VERSION = "2023-06-01";

export function registerProviderModelsHandlers(
    deps: { performModelsRequest?: typeof performModelsRequest } = {},
): void {
    const performRequest = deps.performModelsRequest ?? performModelsRequest;
    registerMethod(
        RPC.providerListModels,
        false,
        async ({
            server,
            params,
        }: MethodCtx<ProviderListModelsParams>): Promise<ProviderListModelsResult> => {
            const resolved = resolveEndpoint(server, params);
            if ("error" in resolved) {
                throw new RpcHandlerError(ErrorCodes.InvalidParams, resolved.error);
            }
            const { baseUrl, api, apiKey } = resolved;

            const url = buildModelsUrl(baseUrl, api);
            let response: Response;
            try {
                response = await performRequest(
                    url,
                    apiKey,
                    api,
                    AbortSignal.timeout(HTTP_TIMEOUT_MS),
                );
            } catch (e) {
                if (e instanceof TimeoutError) {
                    return { ok: false, reason: "timeout", message: "request timed out" };
                }
                return {
                    ok: false,
                    reason: "http-error",
                    message: e instanceof Error ? e.message : "network error",
                };
            }
            if (!response.ok) {
                return {
                    ok: false,
                    reason: "http-error",
                    message: `HTTP ${response.status}`,
                };
            }
            let body: unknown;
            try {
                body = await response.json();
            } catch {
                return { ok: false, reason: "invalid-response", message: "response is not JSON" };
            }
            const models = extractModelIds(body);
            if (models === null) {
                return {
                    ok: false,
                    reason: "invalid-response",
                    message: "could not find a model id list in the response",
                };
            }
            return { ok: true, models };
        },
        { schema: providerListModelsSchema },
    );
}

type ResolvedEndpoint = { baseUrl: string; api: CustomProviderApi; apiKey: string };

/** Normalize the two param shapes into one endpoint triple, or an error message. */
function resolveEndpoint(
    server: MethodCtx<ProviderListModelsParams>["server"],
    params: ProviderListModelsParams,
): ResolvedEndpoint | { error: string } {
    if ("providerId" in params) {
        const { providerId } = params;
        if (typeof providerId !== "string" || providerId.trim() === "") {
            return { error: "providerId is required" };
        }
        const endpoint = server.getProviderEndpoint?.(providerId);
        if (!endpoint) {
            return { error: `unknown provider: ${providerId}` };
        }
        const apiKey = server.providerKeyStore.get(providerId);
        if (!apiKey) {
            return { error: `no API key configured for provider: ${providerId}` };
        }
        return { baseUrl: endpoint.baseUrl, api: endpoint.api, apiKey };
    }
    const { baseUrl, api, apiKey } = params;
    if (typeof baseUrl !== "string" || baseUrl.trim() === "") {
        return { error: "baseUrl is required" };
    }
    if (!isApi(api)) {
        return { error: `unsupported api: ${String(api)}` };
    }
    if (typeof apiKey !== "string" || apiKey.trim() === "") {
        return { error: "apiKey is required" };
    }
    return { baseUrl: baseUrl.trim(), api, apiKey: apiKey.trim() };
}

export async function performModelsRequest(
    url: string,
    apiKey: string,
    api: CustomProviderApi,
    signal: AbortSignal,
): Promise<Response> {
    const authHeaders: Record<string, string> =
        api === "anthropic"
            ? { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION }
            : { Authorization: `Bearer ${apiKey}` };
    try {
        return await fetch(url, {
            method: "GET",
            headers: {
                ...authHeaders,
                ...tacoRequestHeaders(),
            },
            signal,
        });
    } catch (e) {
        if (e instanceof Error && e.name === "AbortError") {
            throw new TimeoutError();
        }
        throw e;
    }
}

export class TimeoutError extends Error {
    constructor() {
        super("request timed out");
        this.name = "TimeoutError";
    }
}

function isApi(value: unknown): value is CustomProviderApi {
    return value === "chatcomplete" || value === "response" || value === "anthropic";
}

/**
 * Concatenate baseUrl with the catalog path. Tolerates trailing slash on
 * baseUrl; does not validate the host (the caller decides what to send).
 * Anthropic's catalog lives at `/v1/models`; a baseUrl already ending in
 * `/v1` (e.g. an Anthropic-compatible gateway) only needs `/models`.
 */
function buildModelsUrl(baseUrl: string, api: CustomProviderApi): string {
    const trimmed = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
    if (api === "anthropic" && !trimmed.endsWith("/v1")) {
        return `${trimmed}/v1/models`;
    }
    return `${trimmed}/models`;
}

/**
 * Parse the four OpenAI-compatible response shapes. Returns the id list, or
 * null if the body is unrecognized (caller maps that to invalid-response).
 * The `id` field is preferred; a non-empty `name` is accepted as a fallback
 * for shapes that omit `id`.
 */
export function extractModelIds(body: unknown): string[] | null {
    if (Array.isArray(body)) {
        return pluckIds(body) ?? null;
    }
    if (body && typeof body === "object") {
        const obj = body as Record<string, unknown>;
        if (Array.isArray(obj.data)) return pluckIds(obj.data) ?? null;
        if (Array.isArray(obj.models)) return pluckIds(obj.models) ?? null;
    }
    return null;
}

function pluckIds(arr: unknown[]): string[] | null {
    // Either `{id: "..."}` objects or plain string entries are accepted.
    const out: string[] = [];
    for (const entry of arr) {
        if (typeof entry === "string") {
            if (entry.length > 0) out.push(entry);
            continue;
        }
        if (entry && typeof entry === "object") {
            const e = entry as Record<string, unknown>;
            const id = e.id;
            if (typeof id === "string" && id.length > 0) {
                out.push(id);
                continue;
            }
            const name = e.name;
            if (typeof name === "string" && name.length > 0) {
                out.push(name);
            }
        }
    }
    // Empty list is a valid (if useless) success — leave the caller to decide.
    return out;
}
