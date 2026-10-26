/**
 * jobs.* RPC param schemas — typebox validators consumed by the contract
 * table in `rpcContract.ts`, which hands each schema to the method it
 * belongs to. The wire shapes live in `@taco-ai/protocol` (`jobs.ts`); these
 * schemas are the runtime counterpart, kept next to the other domain schemas.
 */

import { Type } from "typebox";

const actorSchema = Type.Union([
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

const jobScheduleSchema = Type.Union([
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
    history: Type.Optional(
        Type.Array(
            Type.Object({
                started_at: Type.String(),
                ended_at: Type.Optional(Type.String()),
                status: Type.Union([
                    Type.Literal("running"),
                    Type.Literal("ok"),
                    Type.Literal("err"),
                ]),
                error: Type.Optional(Type.String()),
                summary: Type.Optional(Type.String()),
            }),
        ),
    ),
    generation: Type.Optional(Type.String()),
    channelId: Type.Optional(Type.String()),
    peerId: Type.Optional(Type.String()),
    sessionStrategy: Type.Optional(
        Type.Union([Type.Literal("new"), Type.Literal("reuse"), Type.Literal("pin")]),
    ),
    pinnedSessionId: Type.Optional(Type.String()),
};

/**
 * `jobs.create` body — `id` optional.
 *
 * The daemon generates the id and ignores whatever the caller sends, so the
 * field is accepted but carries no constraints: an older client that echoes
 * an id back must not be rejected for its shape.
 */
const jobCreateBody = Type.Object({
    ...jobBody,
    id: Type.Optional(Type.String()),
});

/** `jobs.update` body — `id` required, since the body replaces an existing job. */
const jobUpdateBody = Type.Object({
    ...jobBody,
    id: Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-zA-Z0-9_-]+$" }),
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
    job: jobUpdateBody,
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
