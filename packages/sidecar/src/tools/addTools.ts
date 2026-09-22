/**
 * addTools — enables the model to load deferred tools on demand.
 *
 * This tool is always present. Its description is a frozen string so the
 * tools JSON (a prompt-cache breakpoint) does not change when a candidate
 * is loaded. The live catalog lives in the system prompt's `<deferred_tools>`
 * section instead.
 *
 * When the model calls addTools("nameA,nameB"), those tools are active from the
 * next turn onward. Already-loaded tools are idempotent no-ops.
 */

import type { Static } from "typebox";
import { Type } from "typebox";
import type {
    AddToolsResult,
    SessionToolController,
} from "../runtime/harness/sessionToolController.ts";
import type { ExecutionToolContext, TextContent } from "../runtime/pi/types.ts";
import type { TacoTool } from "./index.ts";

// Exported so the tools.list handler can surface addTools' schema without a
// live session (the tool object itself is built per-session in attachedSession).
export const addToolsSchema = Type.Object({
    toolNames: Type.String({
        description:
            "Comma-separated tool names from the system prompt's <deferred_tools> list. Already-loaded tools are no-ops.",
    }),
});

export type AddToolsToolInput = Static<typeof addToolsSchema>;

const ADD_TOOLS_DESCRIPTION =
    "Load additional tools by name from the deferred registry. " +
    "Call with a comma-separated list of names from the system prompt's <deferred_tools> section. " +
    "Already-loaded names are no-ops. Unknown names are reported in the result.";

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
                "Retry with a name from the system prompt's <deferred_tools> list.",
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
        description: ADD_TOOLS_DESCRIPTION,
        parameters: addToolsSchema,
        executionMode: "sequential",
        taco: {
            promptSummary:
                "Load additional tools by name on demand from the deferred registry. Only invoke for names listed in the system prompt's <deferred_tools> section.",
            mutates: true,
        },
        async execute(
            _toolCallId: string,
            params: AddToolsToolInput,
            _onUpdate: unknown,
            _context: ExecutionToolContext,
        ): Promise<{ content: TextContent[]; details: AddToolsResult }> {
            const requested = params.toolNames
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
            const result = await controller.addTools(requested);
            // pi 0.86 dropped `addedToolNames` on AgentToolResult. Visibility
            // already rides on setTools / setActiveToolNames in the controller.
            return {
                content: [{ type: "text", text: formatResult(result) }],
                details: result,
            };
        },
    };
}
