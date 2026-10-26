/**
 * catalog.* RPC param schemas — typebox validators consumed by
 * `registerMethod` in `packages/sidecar/src/server/handlers/catalog.ts`.
 *
 * The two provider probes take a discriminated shape: either the id of a
 * saved provider or the fields of one the user is still typing. The schema
 * mirrors that split so a half-filled form fails before the request leaves.
 */

import { Type } from "typebox";

const workspace = Type.String({ minLength: 1 });

const providerApi = Type.Union([
    Type.Literal("chatcomplete"),
    Type.Literal("response"),
    Type.Literal("anthropic"),
]);

export const sessionListModelsSchema = Type.Object({
    workspace,
    provider: Type.Optional(Type.String({ minLength: 1 })),
});

export const providersListSchema = Type.Object({ workspace });

export const providersRevealKeySchema = Type.Object({
    workspace,
    providerId: Type.String({ minLength: 1 }),
});

export const providerListModelsSchema = Type.Union([
    Type.Object({ providerId: Type.String({ minLength: 1 }) }),
    Type.Object({
        baseUrl: Type.String({ minLength: 1 }),
        api: providerApi,
        apiKey: Type.String(),
    }),
]);

export const providerTestConnectionSchema = Type.Union([
    Type.Object({
        providerId: Type.String({ minLength: 1 }),
        modelId: Type.String({ minLength: 1 }),
        apiKey: Type.Optional(Type.String()),
    }),
    Type.Object({
        baseUrl: Type.String({ minLength: 1 }),
        api: providerApi,
        apiKey: Type.String(),
        modelId: Type.String({ minLength: 1 }),
    }),
]);
