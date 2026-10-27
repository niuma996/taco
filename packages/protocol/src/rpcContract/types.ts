/**
 * Shared types for the RPC contract tables.
 *
 * Kept in their own module so the per-domain files can depend on the row
 * shape without importing the aggregate table — that keeps the dependency
 * direction one-way (`types` → domain files → `index`).
 */

import type { Static, TSchema } from "typebox";

/**
 * How the client routes a call.
 *
 * `workspace` — the transport picks a per-workspace sidecar; the call carries
 * a workspace key in its routing position.
 * `process` — the transport picks a process-level sidecar; no workspace
 * dimension travels with the call.
 */
export type RpcScope = "workspace" | "process";

/**
 * One row of the type contract: the wire types of a method.
 *
 * `scope` is the *client routing* dimension — whether the call carries a
 * workspace key. It is deliberately separate from the server's
 * `ensureWorkspace` flag: `workspace.ensure` and `workspace.dispose` are
 * routed by workspace but need no workspace runtime on the server, so the
 * two axes disagree for three methods.
 */
export interface RpcContractRow<P, R, S extends RpcScope = RpcScope> {
    readonly scope: S;
    /** Phantom carrier for the wire params type — never present at runtime. */
    readonly __params?: P;
    /** Phantom carrier for the wire result type — never present at runtime. */
    readonly __result?: R;
}

/**
 * One method declaration: wire name, routing scope, params/result types, and
 * the params schema together.
 *
 * `M` carries the wire name as a literal so the aggregated `RPC` table keeps a
 * union of literals instead of widening to `string`.
 */
export interface DomainRow<
    P,
    R,
    S extends RpcScope,
    Sch extends TSchema,
    M extends string = string,
> {
    readonly method: M;
    readonly scope: S;
    readonly schema: Sch;
    readonly __params?: P;
    readonly __result?: R;
}

/**
 * Declare one method.
 *
 * The params type comes from the schema — the schema is the single definition
 * of the request shape — so only the result type is spelled out. TypeScript
 * has no partial type-argument inference, so `R` is supplied by the first
 * call and the wire name, scope, and schema are inferred by the second.
 */
export function row<R>() {
    return <const M extends string, S extends RpcScope, Sch extends TSchema>(
        method: M,
        scope: S,
        schema: Sch,
    ): DomainRow<ParamsOf<Sch>, R, S, Sch, M> => ({ method, scope, schema });
}

/**
 * The request type of a schema.
 *
 * The schema is the single definition of a request's wire shape: the
 * exported `*Params` types are read off it, so a field cannot drift between
 * the validator and the type. A schema that has to keep a readonly shape
 * (for example `roots: readonly string[]`) pins it with `Type.Unsafe`.
 */
export type ParamsOf<Sch extends TSchema> = Static<Sch>;

type AnyDomainRow = DomainRow<unknown, unknown, RpcScope, TSchema, string>;

export function domainMethods<const T extends Record<string, AnyDomainRow>>(
    rows: T,
): { readonly [K in keyof T]: T[K]["method"] } {
    return Object.fromEntries(Object.entries(rows).map(([key, value]) => [key, value.method])) as {
        readonly [K in keyof T]: T[K]["method"];
    };
}

export function domainContract<const T extends Record<string, AnyDomainRow>>(
    rows: T,
): {
    readonly [K in keyof T]: RpcContractRow<
        T[K] extends DomainRow<infer P, unknown, RpcScope, TSchema, string> ? P : never,
        T[K] extends DomainRow<unknown, infer R, RpcScope, TSchema, string> ? R : never,
        T[K]["scope"]
    >;
} {
    return Object.fromEntries(
        Object.entries(rows).map(([key, value]) => [key, { scope: value.scope }]),
    ) as never;
}

export function domainSchemas<const T extends Record<string, AnyDomainRow>>(
    rows: T,
): { readonly [K in keyof T]: T[K]["schema"] } {
    return Object.fromEntries(
        Object.entries(rows).map(([key, value]) => [key, value.schema]),
    ) as never;
}

/**
 * Whether a params type has lost its request shape.
 *
 * `Type.Any()` and `Type.Unknown()` both widen to a type that accepts
 * everything, so checking only for `any` would miss the `unknown` case.
 * `undefined` is a valid no-params shape and therefore stays `false`.
 */
export type ParamsLacksShape<P> = unknown extends P ? true : false;
