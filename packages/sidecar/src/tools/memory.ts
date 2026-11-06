/**
 * memory tool — let the model add / replace / remove a memory topic.
 * Single tool with action dispatch (hermes builtin style).
 *
 * Routes through the `memory.upsert` RPC rather than the store directly — the
 * handler is the single point of validation and boundary enforcement.
 *
 * The harness injects `workspace` + `call` via `toolContext` (see
 * `tools/context.ts`); the schema only carries business fields.
 */

import {
    MEMORY_CONTENT_MAX_CHARS,
    memoryTopicActionSchema,
    memoryTopicDescriptionSchema,
    memoryTopicIdSchema,
    memoryTopicNameSchema,
    memoryTopicTypeSchema,
    RPC,
} from "@taco-ai/protocol";
import type { Static } from "typebox";
import { Type } from "typebox";
import { withMemoryWriteOrigin } from "../memory/writeOrigin.ts";
import type { AgentHarnessTool } from "../runtime/pi/types.ts";
import type { TacoToolContext } from "./context.ts";

// ─── schema ──────────────────────────────────────────────────────────────────

// Schema is the flat envelope the model sends. The action dispatch happens
// server-side in the memory.upsert RPC handler; this tool is a thin
// self-RPC wrapper. Keep the shape flat (action at top level) so the model
// does not have to nest {action: {action: ...}} — that's the trap the
// previous nested schema kept falling into.
const memoryToolSchema = Type.Object({
    // The id / action / name / description / type fields are the wire
    // contract's own field schemas (`memory.upsert`): the tool reuses them
    // so the model and the server can never disagree about a shape.
    action: memoryTopicActionSchema,
    id: memoryTopicIdSchema,
    name: Type.Optional(memoryTopicNameSchema),
    description: Type.Optional(memoryTopicDescriptionSchema),
    // `content` is the one field the tool narrows: the wire leaves the
    // length to the handler, but the model gets the ceiling in its schema
    // so an oversized body is rejected before the round-trip.
    content: Type.Optional(
        Type.String({
            maxLength: MEMORY_CONTENT_MAX_CHARS,
            description:
                "One coherent durable theme in Markdown. Start with a first-paragraph conclusion " +
                "that stands on its own; add headings, lists, scope, reasons or exceptions when useful. " +
                `Typically 300-1000 characters; maximum ${MEMORY_CONTENT_MAX_CHARS}. ` +
                "Split independent themes into separate ids and cross-reference with [[other-id]]. " +
                "Save non-obvious conclusions, not code, file trees or command output derivable from the repo.",
        }),
    ),
    type: Type.Optional(memoryTopicTypeSchema),
    explicitlyRequested: Type.Optional(
        Type.Boolean({ description: "True only for a direct user request to remember this." }),
    ),
});

export type MemoryToolInput = Static<typeof memoryToolSchema>;

// ─── tool factory ────────────────────────────────────────────────────────────

export function createMemoryTool(): AgentHarnessTool<TacoToolContext> {
    return {
        name: "memory",
        label: "memory",
        description:
            "Save durable information to long-term memory that survives across sessions. " +
            "Storage: one topic file per memory under $TACO_HOME/memory/projects/<workspace-key>/. " +
            "Newest 100 topic summaries are injected into the LLM context as <memory> notes; " +
            "use the read tool on the shown file path to fetch a note's full content. " +
            "Default to no write. Write only for an explicit request to remember, a stable user preference, " +
            "a general correction, a confirmed decision, or a recurring reference useful across sessions. " +
            "Types: user (stable preference), feedback (general correction), project (confirmed decision), " +
            "reference (recurring external resource). Avoid one-off chatter, current-task details or progress, " +
            "assistant guesses, code-derived facts, and information already in CLAUDE.md / <instructions>. " +
            "One memory holds one coherent durable theme in Markdown, with a self-contained conclusion " +
            "in the first paragraph. Headings, lists, scope, reasons and exceptions are welcome when useful. " +
            `Typically 300-1000 characters; ${MEMORY_CONTENT_MAX_CHARS} is the hard maximum. ` +
            "Existing sources identify sessions; use sessionRead to resolve ambiguity before rewriting. " +
            "Never store architecture overviews, directory layouts, code snippets, or command output: " +
            "write those to a doc in the repo and save a `reference` memory pointing at it. " +
            "ACTIONS: add (new entry; REQUIRES name, content and type; fails if id exists; optional description field for relevance matching, defaults to name), " +
            "replace (update content and optional name/description; preserves createdAt, type and sources; " +
            "refreshes updatedAt only when content or metadata changes), " +
            "remove (delete by id; permanent). " +
            "ID NAMING: kebab-case — lowercase letters, digits, and single hyphens only, ≤64 chars. " +
            "Examples: 'user-role', 'feedback-auth'. Underscores, uppercase, dots, or spaces will be rejected.",
        parameters: memoryToolSchema,
        executionMode: "sequential",
        taco: {
            promptSummary:
                "Save or update a long-lived memory note (user / feedback / project / reference). Use sparingly — only for facts that survive the conversation.",
            mutates: true,
        },
        async execute(
            _toolCallId: string,
            params: MemoryToolInput,
            _onUpdate: unknown,
            ctx: TacoToolContext,
        ): Promise<{ content: { type: "text"; text: string }[]; details: unknown }> {
            const { workspace, call } = ctx;
            if (!call) {
                throw new Error("memory.upsert: no self-RPC dispatcher in this workspace");
            }
            const result = await withMemoryWriteOrigin(ctx.sessionId, () =>
                call(RPC.memoryUpsert, workspace, {
                    workspace,
                    action: params.action,
                    id: params.id,
                    name: params.name,
                    description: params.description,
                    content: params.content,
                    type: params.type,
                    ...(params.explicitlyRequested === undefined
                        ? {}
                        : { explicitlyRequested: params.explicitlyRequested }),
                }),
            );
            const text = `memory.upsert ${result.outcome}: ${params.id}`;
            return {
                content: [{ type: "text", text }],
                details: result,
            };
        },
    };
}
