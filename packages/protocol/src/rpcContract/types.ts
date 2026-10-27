/**
 * Shared types for the RPC contract tables.
 *
 * Kept in their own module so the per-domain files can depend on the row
 * shape without importing the aggregate table — that keeps the dependency
 * direction one-way (`types` → domain files → `index`).
 */

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
 * The same shape with every `readonly` modifier dropped.
 *
 * The wire types declare their fields `readonly`, while a typebox schema
 * describes a mutable object. The two are the same value at runtime, but
 * `readonly string[]` is not assignable to `string[]`, so comparing the
 * types directly would report a mismatch for every readonly field. Dropping
 * the modifiers compares the shapes that actually travel the wire.
 *
 * The primitive branch comes first on purpose: a branded id (`WorkspaceId`,
 * `SessionId`) is a string intersected with a brand, and mapping over it as
 * an object would replace the string with an object of its members.
 */
export type DeepMutable<T> = T extends
    | string
    | number
    | boolean
    | symbol
    | bigint
    | null
    | undefined
    ? T
    : T extends readonly (infer U)[]
      ? DeepMutable<U>[]
      : T extends object
        ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
        : T;

/**
 * Whether a schema's static type names any field at all.
 *
 * `Type.Any()` and `Type.Unknown()` accept every value, so their static type
 * is `any`/`unknown` and says nothing about which fields exist. Comparing
 * against them would report a mismatch for every method; the check therefore
 * only applies once a schema names its fields.
 */
export type SchemaHasShape<S> = unknown extends S ? false : true;
