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

import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import type { MemoryUpsertParams, MemoryUpsertResult } from "@taco-ai/protocol";
import { MEMORY_CONTENT_MAX_CHARS } from "@taco-ai/protocol";
import type { Static } from "typebox";
import { Type } from "typebox";
import type { TacoToolContext } from "./context.ts";

// ─── schema ──────────────────────────────────────────────────────────────────

const actionSchema = Type.Union([
    Type.Literal("add"),
    Type.Literal("replace"),
    Type.Literal("remove"),
]);

// Schema is the flat envelope the model sends. The action dispatch happens
// server-side in the memory.upsert RPC handler; this tool is a thin
// self-RPC wrapper. Keep the shape flat (action at top level) so the model
// does not have to nest {action: {action: ...}} — that's the trap the
// previous nested schema kept falling into.
const memoryToolSchema = Type.Object({
    action: actionSchema,
    // Whitelisted by the handler as `^[a-z0-9-]{1,64}$`. Express the same
    // rule here so the JSON Schema is the contract, not the handler's
    // post-hoc sanitizer.
    id: Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z0-9-]+$" }),
    name: Type.Optional(
        Type.String({
            maxLength: 60,
            description: "Short human-readable title for this memory. Not a sentence.",
        }),
    ),
    description: Type.Optional(
        Type.String({
            maxLength: 120,
            description:
                "One line stating what this memory is about, used to judge relevance in later sessions. Defaults to `name`.",
        }),
    ),
    content: Type.Optional(
        Type.String({
            maxLength: MEMORY_CONTENT_MAX_CHARS,
            description:
                "The fact itself, stated as briefly as it can be stated — typically 1-3 sentences, " +
                `well under the ${MEMORY_CONTENT_MAX_CHARS}-char ceiling. One memory holds ONE fact. ` +
                "If the body needs headings, bullet lists, or covers several independent facts, " +
                "that is two or more memories: split it into separate ids and cross-reference them " +
                "with [[other-id]]. Do not paste code, file trees, command output, or architecture " +
                "overviews — those are derivable from the repo; save the non-obvious conclusion instead. " +
                "For feedback/project types, follow the fact with a short `Why:` clause.",
        }),
    ),
    type: Type.Optional(
        Type.Union([
            Type.Literal("user"),
            Type.Literal("feedback"),
            Type.Literal("project"),
            Type.Literal("reference"),
        ]),
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
            "Storage: $TACO_HOME/memory/projects/{cwd}/{id}.md (per-workspace topic files). " +
            "Newest 100 topic summaries are injected into the LLM context as <memory> notes; " +
            "use the read tool on the shown file path to fetch a note's full content. " +
            "WHEN TO CALL (proactively, don't wait to be asked): " +
            "User reveals persona/preferences/role/tech stack → type=user; " +
            "User explicitly corrects or confirms your behavior → type=feedback; " +
            "Project-level fact NOT derivable from current code → type=project; " +
            "External system reference (URL/file path/tool) → type=reference. " +
            "DO NOT CALL for: task progress (use TaskWrite), code patterns (derivable), " +
            "info already in CLAUDE.md / <instructions>. " +
            "ONE MEMORY = ONE FACT, stated in 1-3 sentences. Every topic body is injected into " +
            "later sessions' context, so length is a shared budget, not private space. " +
            `The ${MEMORY_CONTENT_MAX_CHARS}-char cap is a hard ceiling, not a target — a body that ` +
            "approaches it is almost always several facts that belong in separate ids. " +
            "Never store architecture overviews, directory layouts, code snippets, or command output: " +
            "write those to a doc in the repo and save a `reference` memory pointing at it. " +
            "ACTIONS: add (new entry; fails if id exists; optional description field for relevance matching, defaults to name), " +
            "replace (overwrite existing by id; preserves createdAt, sets updatedAt; only updates content — " +
            "to change name/type/description, remove+add), " +
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
            _signal: AbortSignal | undefined,
            _onUpdate: unknown | undefined,
            ctx: TacoToolContext,
        ): Promise<{ content: { type: "text"; text: string }[]; details: unknown }> {
            const { workspace, call } = ctx;
            if (!call) {
                throw new Error("memory.upsert: no self-RPC dispatcher in this workspace");
            }
            const result = await call<MemoryUpsertParams, MemoryUpsertResult>(
                "memory.upsert",
                workspace,
                {
                    workspace,
                    action: params.action,
                    id: params.id,
                    name: params.name,
                    description: params.description,
                    content: params.content,
                    type: params.type,
                },
            );
            const text = `memory.upsert ${result.outcome}: ${params.id}`;
            return {
                content: [{ type: "text", text }],
                details: result,
            };
        },
    };
}
