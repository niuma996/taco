import {
    MEMORY_CONTENT_MAX_CHARS,
    memoryTopicDescriptionSchema,
    memoryTopicIdSchema,
    memoryTopicNameSchema,
    memoryTopicTypeSchema,
} from "@taco-ai/protocol";
import { Type } from "typebox";

export const MAX_AUTOMATIC_ACTIONS = 3;
export const MEMORY_BASES = [
    "durable_preference",
    "correction",
    "confirmed_decision",
    "recurring_reference",
] as const;

const fields = {
    content: Type.String({ minLength: 1, maxLength: MEMORY_CONTENT_MAX_CHARS, pattern: "\\S" }),
    basis: Type.Union(MEMORY_BASES.map((basis) => Type.Literal(basis))),
    evidence: Type.String({ minLength: 4, maxLength: 200, pattern: "\\S" }),
    futureUse: Type.String({ minLength: 1, maxLength: 300, pattern: "\\S" }),
};
export const memoryExtractionTool = {
    name: "submit_memory_extraction",
    description:
        "Submit the final memory extraction actions exactly once; use an empty actions array when no durable memory is warranted.",
    parameters: Type.Object(
        {
            actions: Type.Array(
                Type.Union([
                    Type.Object(
                        {
                            ...fields,
                            action: Type.Literal("add"),
                            id: memoryTopicIdSchema,
                            name: memoryTopicNameSchema,
                            description: memoryTopicDescriptionSchema,
                            type: memoryTopicTypeSchema,
                        },
                        { additionalProperties: false },
                    ),
                    Type.Object(
                        {
                            ...fields,
                            action: Type.Literal("update"),
                            id: Type.String({ minLength: 1, maxLength: 128, pattern: "\\S" }),
                            name: Type.Optional(memoryTopicNameSchema),
                            description: Type.Optional(memoryTopicDescriptionSchema),
                        },
                        { additionalProperties: false },
                    ),
                ]),
                { maxItems: MAX_AUTOMATIC_ACTIONS },
            ),
        },
        { additionalProperties: false },
    ),
};
