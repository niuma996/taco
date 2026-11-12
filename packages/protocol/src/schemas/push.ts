/** Lifecycle pushes share owner identity; started never declares new topology. */
import { Type } from "typebox";
import { sessionIdSchema } from "./fields.js";

const owner = {
    parentSessionId: sessionIdSchema,
    parentToolCallId: Type.String({ minLength: 1 }),
    subSessionId: sessionIdSchema,
    agentType: Type.String({ minLength: 1 }),
};

export const subagentStartedSchema = Type.Object({
    ...owner,
    runId: Type.String({ minLength: 1 }),
});

export const pushSchemas = {
    "subagent.started": subagentStartedSchema,
    "subagent.spawned": Type.Object({
        ...owner,
        runId: Type.Optional(Type.String({ minLength: 1 })),
    }),
    "subagent.settled": Type.Object({
        ...owner,
        outcome: Type.Union([
            Type.Literal("completed"),
            Type.Literal("error"),
            Type.Literal("aborted"),
        ]),
        runId: Type.Optional(Type.String({ minLength: 1 })),
    }),
};
