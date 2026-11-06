import {
    MEMORY_CONTENT_MAX_CHARS,
    memoryTopicDescriptionSchema,
    memoryTopicIdSchema,
    memoryTopicNameSchema,
    memoryTopicTypeSchema,
} from "@taco-ai/protocol";
import { Type } from "typebox";
import { DREAM_ARCHIVE_CATEGORIES, MAX_DREAM_ACTIONS } from "./dreamPlan.ts";

// Existing references may use legacy ids; new merge targets follow the write contract.
const existingId = Type.String({ minLength: 1, maxLength: 128, pattern: "\\S" });
const content = Type.String({
    minLength: 1,
    maxLength: MEMORY_CONTENT_MAX_CHARS,
    pattern: "\\S",
    description: "Complete Markdown body preserving all still-true details.",
});
const dreamAction = Type.Union([
    Type.Object(
        {
            action: Type.Literal("merge"),
            sourceIds: Type.Array(existingId, { minItems: 2, uniqueItems: true }),
            id: memoryTopicIdSchema,
            name: memoryTopicNameSchema,
            description: memoryTopicDescriptionSchema,
            type: memoryTopicTypeSchema,
            content,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            action: Type.Literal("rewrite"),
            id: existingId,
            content,
            name: Type.Optional(memoryTopicNameSchema),
            description: Type.Optional(memoryTopicDescriptionSchema),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            action: Type.Literal("archive"),
            id: existingId,
            reason: Type.String({ minLength: 1, pattern: "\\S" }),
            category: Type.Optional(
                Type.Union(DREAM_ARCHIVE_CATEGORIES.map((category) => Type.Literal(category))),
            ),
            evidence: Type.Optional(Type.String({ minLength: 1 })),
            supersededBy: Type.Optional(existingId),
        },
        { additionalProperties: false },
    ),
]);

export const dreamResultTool = {
    name: "submit_memory_dream_plan",
    description:
        "Submit exactly one complete memory consolidation plan for validation. " +
        "This tool does not write files. Use an empty actions array when no changes are needed.",
    parameters: Type.Object(
        { actions: Type.Array(dreamAction, { maxItems: MAX_DREAM_ACTIONS }) },
        { additionalProperties: false },
    ),
};
