/**
 * jobs.* RPC param schemas — typebox validators consumed by the contract
 * table in `rpcContract/jobs.ts`, which hands each schema to the method it
 * belongs to.
 *
 * This module is also the source of the wire shapes: the request types in
 * `packages/protocol/src/jobs.ts` are derived from these schemas, so a field
 * is declared exactly once.
 */

import { Type } from "typebox";

/**
 * Per-call caller identity, attached to `jobs.*` params so the server can
 * enforce IM-scope (one channel/peer) vs IDE-scope (one fs workspace).
 *
 * The `ide` branch carries a filesystem path, not a workspace id, so it
 * stays an unbranded string.
 */
export const actorSchema = Type.Union([
    Type.Object({
        kind: Type.Literal("im"),
        channelId: Type.String({ minLength: 1 }),
        peerId: Type.String({ minLength: 1 }),
        chatId: Type.String({ minLength: 1 }),
    }),
    Type.Object({
        kind: Type.Literal("ide"),
        workspace: Type.String({ minLength: 1 }),
    }),
]);

/** A job's schedule — either a cron expression or a fixed interval. */
export const jobScheduleSchema = Type.Union([
    Type.Object({
        kind: Type.Literal("cron"),
        expr: Type.String({ minLength: 1 }),
        tz: Type.Optional(Type.String()),
    }),
    Type.Object({
        kind: Type.Literal("interval"),
        ms: Type.Integer({ minimum: 1 }),
    }),
]);

/**
 * How the scheduler picks a session when an `agent.invoke` job fires.
 *
 * IM defaults to `reuse` and only permits `reuse`. Filesystem workspaces
 * default to `pin` and may explicitly select `new`.
 */
export const sessionStrategySchema = Type.Union([
    Type.Literal("new"),
    Type.Literal("reuse"),
    Type.Literal("pin"),
]);

/** One past run of a job. */
export const jobHistoryEntrySchema = Type.Object({
    started_at: Type.String(),
    ended_at: Type.Optional(Type.String()),
    status: Type.Union([Type.Literal("running"), Type.Literal("ok"), Type.Literal("err")]),
    error: Type.Optional(Type.String()),
    /** One-line outcome a built-in handler reports (e.g. "merged 12→4"). */
    summary: Type.Optional(Type.String()),
});

/**
 * The job body shared by create and update.
 *
 * `id` is deliberately absent: create lets the daemon mint it, so the two
 * methods declare different bodies (see `jobCreateBody` / `jobUpdateBody`).
 */
const jobBody = {
    name: Type.String(),
    schedule: jobScheduleSchema,
    command: Type.String({ minLength: 1 }),
    args: Type.Record(Type.String(), Type.Unknown()),
    builtin: Type.Optional(Type.Boolean()),
    enabled: Type.Boolean(),
    run_on_startup: Type.Boolean(),
    max_runs: Type.Optional(Type.Integer({ minimum: 1 })),
    run_count: Type.Optional(Type.Integer({ minimum: 0 })),
    max_consecutive_failures: Type.Optional(Type.Integer({ minimum: 0 })),
    consecutive_failures: Type.Optional(Type.Integer({ minimum: 0 })),
    disabled_reason: Type.Optional(Type.String()),
    last_run_at: Type.Optional(Type.String()),
    next_run_at: Type.Optional(Type.String()),
    history: Type.Optional(Type.Array(jobHistoryEntrySchema)),
    generation: Type.Optional(Type.String()),
    channelId: Type.Optional(Type.String()),
    peerId: Type.Optional(Type.String()),
    sessionStrategy: Type.Optional(sessionStrategySchema),
    pinnedSessionId: Type.Optional(Type.String()),
};

/**
 * A full job — `id` required.
 *
 * This is the canonical wire shape of a job: the body `jobs.update` replaces
 * an existing job with, and the shape the server returns from `jobs.list` /
 * `jobs.get`.
 */
export const jobSchema = Type.Object({
    ...jobBody,
    id: Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-zA-Z0-9_-]+$" }),
});

/**
 * `jobs.create` body — `id` optional.
 *
 * The daemon generates the id and ignores whatever the caller sends, so the
 * field is accepted but carries no constraints: an older client that echoes
 * an id back must not be rejected for its shape.
 */
export const jobCreateBody = Type.Object({
    ...jobBody,
    id: Type.Optional(Type.String()),
});

const jobIdSchema = Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-zA-Z0-9_-]+$" });

export const jobsListSchema = Type.Object({
    actor: Type.Optional(actorSchema),
});

export const jobsGetSchema = Type.Object({
    id: jobIdSchema,
    actor: Type.Optional(actorSchema),
});

export const jobsCreateSchema = Type.Object({
    job: jobCreateBody,
    actor: Type.Optional(actorSchema),
});

export const jobsUpdateSchema = Type.Object({
    job: jobSchema,
    actor: Type.Optional(actorSchema),
});

export const jobsDeleteSchema = Type.Object({
    id: jobIdSchema,
    actor: Type.Optional(actorSchema),
});

export const jobsRunNowSchema = Type.Object({
    id: jobIdSchema,
    actor: Type.Optional(actorSchema),
});

export const jobsHistorySchema = Type.Object({
    id: jobIdSchema,
    actor: Type.Optional(actorSchema),
});
