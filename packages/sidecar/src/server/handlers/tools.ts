/**
 * tools.* handler — list workspace-available tools (builtin +
 * extension + session). Sources: workspace.tools
 * (defaultToolsWithTasks() + extension tools, dedupOverride already
 * applied) and workspace.sessionRegistry.getListingTools()
 * (session-level agent / skill). Categories: "builtin" /
 * "external" (may override same-named builtin) / "session"
 * (main-session-only meta-tools). availableInSubagent is an
 * OR-aggregation UI signal across workspace.agents whitelists.
 */

import type { ToolEntry, ToolsListParams, ToolsListResult } from "@taco-ai/protocol";
import { toolsListSchema } from "@taco-ai/protocol";
import { RPC } from "@taco-ai/shared";
import { isToolVisibleForAnySubagent } from "../../agents/filterTools.ts";
import { addToolsSchema } from "../../tools/addTools.ts";
import type { TacoTool } from "../../tools/index.ts";
import { type MethodCtx, registerMethod } from "../methodRegistry.ts";

function toEntry(
    tool: Pick<TacoTool, "name" | "label" | "description" | "parameters">,
    category: ToolEntry["category"],
    availableInSubagent: boolean | undefined,
): ToolEntry {
    return {
        name: tool.name,
        label: tool.label,
        description: tool.description,
        category,
        inputSchema: tool.parameters,
        availableInSubagent,
    };
}

export function registerToolsHandlers(): void {
    registerMethod(
        RPC.toolsList,
        true,
        async ({ workspace }: MethodCtx<ToolsListParams>): Promise<ToolsListResult> => {
            // workspace.tools is the merged result of defaultToolsWithTasks()
            // plus extension tools (extension same-named tools override
            // builtin). Used for `tools.list` and other sessionId-independent
            // surfaces.
            const baseTools = workspace.tools;

            const extContribs = workspace.extensions?.toolsWithSource() ?? [];
            const extNames = new Set(extContribs.map((e) => e.tool.name));

            // Subagent visibility (OR-aggregation): under the full
            // workspace.agents whitelist set, whether a depth=1 subagent
            // has a path to the tool.
            const whitelists = workspace.agents.map((a) => a.tools);
            const computeVisible = (name: string): boolean | undefined => {
                if (whitelists.length === 0) return undefined;
                return isToolVisibleForAnySubagent(name, whitelists);
            };

            // builtin: non-extension tools in workspace.tools
            const builtin: ToolEntry[] = baseTools
                .filter((t) => !extNames.has(t.name))
                .map((t) => toEntry(t, "builtin", computeVisible(t.name)));

            // external: tools registered by an extension (may override
            // a same-named builtin)
            const external: ToolEntry[] = extContribs.map((e) =>
                toEntry(e.tool, "external", computeVisible(e.tool.name)),
            );

            // session: meta-tools injected only in the main session
            // (agent / skill / addTools)
            const session: ToolEntry[] = workspace.sessionRegistry
                .getListingTools()
                .map((t) => toEntry(t, "session", computeVisible(t.name)));

            // addTools is also session-scoped, but it is constructed per-session
            // in attachedSession (not in sessionRegistry), so the listing must add
            // it explicitly. Its real description is a getter that reflects live
            // registry state; here we surface a static summary. Not reachable from
            // a subagent (subagents share no deferred registry).
            session.push({
                name: "addTools",
                label: "addTools",
                description:
                    "Load additional deferred tools by name on demand. Only usable in the main session; subagents cannot reach it. The current set of loadable tools is appended to this tool's description at runtime, so re-read it (or invoke it) to see what's available now.",
                category: "session",
                inputSchema: addToolsSchema,
                availableInSubagent: false,
                loading: "always",
            });

            // mcp: tools provided by MCP servers, registered via the
            // workspace's deferred-tool registry. They live separately from
            // `workspace.tools` because they are loaded lazily (or eagerly
            // for "always") — UI surfaces both here so users can see what
            // their MCP config exposes, alongside the static toolset.
            const registry = workspace.toolRegistry;
            const mcpEntries: ToolEntry[] = registry
                ? await Promise.all(
                      registry.listCandidates().map(async (candidate) => {
                          const tool = await candidate.load();
                          return {
                              ...toEntry(tool, "mcp", computeVisible(candidate.name)),
                              source: candidate.source,
                              loading: candidate.loading,
                          };
                      }),
                  )
                : [];

            return { tools: [...builtin, ...external, ...mcpEntries, ...session] };
        },
        { schema: toolsListSchema },
    );
}
