/**
 * addTools — enables the model to load deferred tools on demand.
 *
 * This tool is always present: its schema is in the initial system prompt.
 * The description is a getter so it reflects the current registry state
 * (deferred candidates minus already-loaded tools) without rebuilding the tool object.
 *
 * When the model calls addTools("nameA,nameB"), those tools are active from the
 * next turn onward. Already-loaded tools are idempotent no-ops.
 */

import type { ExecutionToolContext } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import { Type } from "typebox";
import type { AddToolsResult, SessionToolController } from "../runtime/sessionToolController.ts";
import type { TacoTool } from "./index.ts";

// Exported so the tools.list handler can surface addTools' schema without a
// live session (the tool object itself is built per-session in attachedSession).
export const addToolsSchema = Type.Object({
    toolNames: Type.String({
        description:
            "Comma-separated tool names from the Available deferred tools list below. Already-loaded tools are no-ops.",
    }),
});

export type AddToolsToolInput = Static<typeof addToolsSchema>;

function buildDescription(controller: SessionToolController): string {
    // Subtract tools already loaded in this session — model must only see candidates
    // that are not yet active.
    const loaded = new Set(controller.loadedToolNames());
    const deferred = controller.registry.listDeferred().filter((c) => !loaded.has(c.name));
    if (deferred.length === 0) {
        return "Load additional tools by name. (No deferred tools available in this session.)";
    }
    return [
        "Load additional tools by name. Already-loaded tools are no-ops.",
        "",
        "Available deferred tools:",
        ...deferred.map((c) => `  - ${c.name}: ${c.summary}`),
    ].join("\n");
}

function formatResult(result: AddToolsResult): string {
    const lines: string[] = [];
    if (result.added.length > 0) {
        lines.push(
            `Loaded tools: ${result.added.join(", ")}. They are now available for use in subsequent turns.`,
        );
    }
    if (result.skipped.length > 0) {
        lines.push(`Already loaded: ${result.skipped.join(", ")}.`);
    }
    if (result.unknown.length > 0) {
        lines.push(
            `Unknown tools (not in the available list): ${result.unknown.join(", ")}. ` +
                "Retry with a name from the Available deferred tools list.",
        );
    }
    if (result.failed.length > 0) {
        lines.push(
            `Failed to load: ${result.failed.map((f) => `${f.name} (${f.error})`).join(", ")}.`,
        );
    }
    return lines.length > 0 ? lines.join("\n") : "No tools to load.";
}

export function createAddToolsTool(controller: SessionToolController): TacoTool {
    return {
        name: "addTools",
        label: "addTools",
        get description(): string {
            return buildDescription(controller);
        },
        parameters: addToolsSchema,
        executionMode: "sequential",
        taco: {
            promptSummary:
                "Load additional tools by name on demand from the deferred registry. Only invoke for tools listed under 'Available deferred tools' in this tool's description.",
            mutates: true,
        },
        async execute(
            _toolCallId: string,
            params: AddToolsToolInput,
            _signal: AbortSignal | undefined,
            _onUpdate: unknown,
            _context: ExecutionToolContext,
        ): Promise<{ content: TextContent[]; details: AddToolsResult; addedToolNames?: string[] }> {
            const requested = params.toolNames
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
            const result = await controller.addTools(requested);
            return {
                content: [{ type: "text", text: formatResult(result) }],
                details: result,
                // pi-agent-core writes this to the transcript; pi-ai picks it up to inject
                // deferred tool schemas into the next provider request.
                addedToolNames: result.added.length > 0 ? result.added : undefined,
            };
        },
    };
}
