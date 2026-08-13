/**
 * provider.listModels — top-level RPC that fetches `/v1/models` from a custom
 * provider so the form can suggest ids. Workspace-less: this is a config-time
 * helper, not a session concern. The key travels in `params.apiKey` and is
 * never persisted, logged, or echoed back. Only chatcomplete has a public
 * catalog; other protocols return protocol-not-supported. Response shape is
 * parsed tolerantly by `extractModelIds`.
 */

import type {
    CustomProviderApi,
    ProviderListModelsParams,
    ProviderListModelsResult,
} from "@taco-ai/protocol";
import { ErrorCodes, providerListModelsSchema } from "@taco-ai/protocol";
import { RPC } from "@taco-ai/shared";
import { type MethodCtx, RpcHandlerError, registerMethod } from "../methodRegistry.ts";

const HTTP_TIMEOUT_MS = 5_000;

export function registerProviderModelsHandlers(
    deps: { performModelsRequest?: typeof performModelsRequest } = {},
): void {
    const performRequest = deps.performModelsRequest ?? performModelsRequest;
    registerMethod(
        RPC.providerListModels,
        false,
        async ({
            params,
        }: MethodCtx<ProviderListModelsParams>): Promise<ProviderListModelsResult> => {
            const { baseUrl, api, apiKey } = params;
            if (typeof baseUrl !== "string" || baseUrl.trim() === "") {
                throw new RpcHandlerError(ErrorCodes.InvalidParams, "baseUrl is required");
            }
            if (!isApi(api)) {
                throw new RpcHandlerError(
                    ErrorCodes.InvalidParams,
                    `unsupported api: ${String(api)}`,
                );
            }
            if (typeof apiKey !== "string" || apiKey.trim() === "") {
                throw new RpcHandlerError(ErrorCodes.InvalidParams, "apiKey is required");
            }

            if (api !== "chatcomplete") {
                return {
                    ok: false,
                    reason: "protocol-not-supported",
                    message: reasonMessage(api),
                };
            }

            const url = buildModelsUrl(baseUrl.trim());
            let response: Response;
            try {
                response = await performRequest(
                    url,
                    apiKey.trim(),
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

export async function performModelsRequest(
    url: string,
    apiKey: string,
    signal: AbortSignal,
): Promise<Response> {
    try {
        return await fetch(url, {
            method: "GET",
            headers: { Authorization: `Bearer ${apiKey}` },
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

function reasonMessage(api: CustomProviderApi): string {
    if (api === "response") {
        return "OpenAI Responses API has no public /v1/models endpoint; please type model ids manually";
    }
    return "Anthropic has no public /v1/models endpoint; please type model ids manually";
}

/**
 * Concatenate baseUrl with `/models`. Tolerates trailing slash on baseUrl;
 * does not validate the host (the caller decides what to send).
 */
function buildModelsUrl(baseUrl: string): string {
    const trimmed = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
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
