import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import type { AssistantMessage } from "../runtime/pi/types.ts";

// JSON Schema counts code points; memory storage and metadata limits count UTF-16 units.
function fitsStorageLengths(schema: TSchema, value: unknown): boolean {
    const node = schema as TSchema & {
        maxLength?: number;
        anyOf?: TSchema[];
        items?: TSchema;
        properties?: Record<string, TSchema>;
    };
    if (typeof value === "string" && typeof node.maxLength === "number") {
        return value.length <= node.maxLength;
    }
    if (Array.isArray(node.anyOf)) {
        return node.anyOf.some(
            (branch: TSchema) => Value.Check(branch, value) && fitsStorageLengths(branch, value),
        );
    }
    if (Array.isArray(value) && node.items) {
        return value.every((item) => fitsStorageLengths(node.items as TSchema, item));
    }
    if (value && typeof value === "object" && node.properties) {
        const record = value as Record<string, unknown>;
        return Object.entries(node.properties).every(
            ([key, property]) => !(key in record) || fitsStorageLengths(property, record[key]),
        );
    }
    return true;
}

/** Accept one complete result call; prose and partial arguments never become a plan. */
export function readMemorySubmission<S extends TSchema>(
    response: AssistantMessage,
    tool: { name: string; parameters: S },
): Static<S> {
    if (
        response.stopReason === "error" ||
        response.stopReason === "aborted" ||
        response.stopReason === "length" ||
        response.stopReason === "pending" ||
        response.stopReason === "deferred"
    ) {
        throw new Error(`incomplete ${tool.name} response: ${response.stopReason}`);
    }
    const calls = response.content.filter((block) => block.type === "toolCall");
    if (calls.length !== 1 || calls[0]?.name !== tool.name) {
        throw new Error(`expected exactly one ${tool.name} tool call`);
    }
    const call = calls[0];
    if (
        call.argumentsError !== undefined ||
        !Value.Check(tool.parameters, call.arguments) ||
        !fitsStorageLengths(tool.parameters, call.arguments)
    ) {
        throw new Error(`invalid ${tool.name} arguments`);
    }
    return call.arguments;
}
