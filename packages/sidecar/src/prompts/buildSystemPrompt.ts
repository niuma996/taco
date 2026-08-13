/**
 * buildSystemPrompt — assemble TACO's system prompt from static template
 * modules plus host-derived data.
 *
 * Static, process-lifetime content lives here (identity, rules, platform).
 * Per-turn / session-mutable content (CLAUDE.md, cwd, time) is injected as
 * context tags by `runtime/attachedSession.ts`. Templates are `.ts` constants
 * (not `.md`) so no dist-path resolution and strings are type-checked.
 */

import { buildPlatformPrompt } from "./buildPlatformPrompt.ts";
import { fillPlaceholders } from "./fillPlaceholders.ts";
import { CORE_TEMPLATE, PATH_SEMANTICS_DEFAULT, PATH_SEMANTICS_HIDDEN } from "./templates/core.ts";
import { toolSummaryForPrompt } from "./toolSummary.ts";
import type { NamedTool } from "./types.ts";

// Re-export for callers that already import `NamedTool` from this module.
export type { NamedTool } from "./types.ts";

/**
 * Tags callers can attach to a contributor so the rebuild path (subagent
 * construction) can decide whether the section still applies to a reduced
 * toolset. Add new tags here when a contributor's relevance depends on a
 * specific tool being present — keeps the decision logic in one place.
 */
export type SystemPromptContributorTag = "skills";

/** Runtime role of the session this prompt is being assembled for. */
export interface SessionKind {
    /** `"main"` for the user's primary session; `"subagent"` for agent-tool delegations. */
    role: "main" | "subagent";
    /** Subagent nesting depth; 0 for main sessions. */
    depth: number;
}

/** A section a caller wants to graft onto the assembled prompt. */
export interface SystemPromptContributor {
    prepend?: string;
    append?: string;
    /** Optional capabilities the contributor requires. The subagent rebuilder
     *  drops a contributor whose required tags are not satisfied by the
     *  child's toolset, so a read-only agent does not see a `<skill>`
     *  listing it cannot act on. */
    requires?: ReadonlyArray<SystemPromptContributorTag>;
}

/**
 * Filter a contributor list down to the entries whose `requires` tags are
 * satisfied by the given available tool names. A contributor without
 * `requires` is always kept.
 */
export function filterContributorsForTools(
    contributors: ReadonlyArray<SystemPromptContributor> | undefined,
    availableToolNames: ReadonlySet<string>,
): SystemPromptContributor[] {
    if (!contributors || contributors.length === 0) return [];
    return contributors.filter((c) => {
        if (!c.requires || c.requires.length === 0) return true;
        return c.requires.every((tag) => {
            switch (tag) {
                case "skills":
                    return availableToolNames.has("skill");
            }
            // Exhaustiveness check: adding a new tag without a `case` above
            // fails the `never` assignment at compile time. Without this,
            // an unknown tag would silently fall through to `false` and
            // drop the contributor without warning.
            const _exhaustive: never = tag;
            return _exhaustive;
        });
    });
}

export interface BuildSystemPromptOptions {
    /** Session tools — their names are rendered into the core template. */
    tools: ReadonlyArray<NamedTool>;
    /** Host platform; defaults to `process.platform`. Injectable for tests. */
    platform?: NodeJS.Platform;
    /**
     * Identity of the model this prompt is being assembled for. Rendered
     * into the `<model_identity>` section so the model has a self-reference
     * for cost / context-window reasoning. Defaults to "unknown" when the
     * caller can't supply it — this keeps the placeholder valid rather
     * than leaving a literal `{{MODEL_IDENTITY}}` token in the prompt.
     */
    modelIdentity?: string;
    /**
     * Pre-rendered `<project_context>` block (already truncated by the
     * caller via `projectContextForPrompt`). Empty string or undefined
     * omits the section entirely. Passed as a string rather than a path so
     * `buildSystemPrompt` stays free of fs I/O — the workspace layer is
     * responsible for reading once at construction.
     */
    projectContext?: string;
    /** Reserved extension point; empty today. */
    contributors?: SystemPromptContributor[];
    /**
     * Runtime role of the session this prompt is being assembled for. Defaults
     * to `{ role: "main", depth: 0 }` so callers that do not care about the
     * distinction continue to work.
     */
    sessionKind?: SessionKind;
    /**
     * When true, the prompt carries an extra paragraph instructing the model
     * not to reveal the workspace path or project structure. Used for
     * IM/third-party channels where replies leave the local machine.
     */
    hideWorkspacePath?: boolean;
}

const SECTION_SEPARATOR = "\n\n---\n\n";

export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
    const toolNames = options.tools.map((t) => t.name);
    const toolNamesText = toolNames.join(", ");
    const sessionKind = options.sessionKind ?? { role: "main", depth: 0 };

    const core = fillPlaceholders(CORE_TEMPLATE, {
        TOOL_NAMES: toolNamesText,
        MODEL_IDENTITY: options.modelIdentity ?? "unknown",
        SESSION_ROLE: sessionKind.role,
        DEPTH_LINE: sessionKind.depth > 0 ? ` Depth: ${sessionKind.depth}.` : "",
        PATH_SEMANTICS: options.hideWorkspacePath ? PATH_SEMANTICS_HIDDEN : PATH_SEMANTICS_DEFAULT,
    });
    const platform = buildPlatformPrompt(options.platform, toolNames);
    const toolSummary = toolSummaryForPrompt(options.tools);
    const projectContext = options.projectContext ?? "";

    const parts: string[] = [core];
    if (toolSummary) parts.push(toolSummary);
    if (projectContext) parts.push(projectContext);
    parts.push(platform);

    if (options.hideWorkspacePath) {
        parts.push(
            [
                "<channel_safety>",
                "You are running over a third-party channel. Do not reveal the current working directory, absolute filesystem paths, or project structure in your replies. Keep references relative or omit the path entirely when possible.",
                "This applies to quoting tool results too: file contents, command output, and error messages may embed absolute paths. When you relay or summarize them, strip the path down to its relative form or omit it.",
                "</channel_safety>",
            ].join("\n"),
        );
    }

    for (const contributor of options.contributors ?? []) {
        if (contributor.prepend) parts.unshift(contributor.prepend);
        if (contributor.append) parts.push(contributor.append);
    }

    return parts.join(SECTION_SEPARATOR);
}
