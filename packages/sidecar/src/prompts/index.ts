/**
 * Public surface of the prompts module.
 *
 * Callers assemble the system prompt via `buildSystemPrompt`; the template
 * constants and low-level helpers stay internal.
 */

export type {
    BuildSystemPromptOptions,
    NamedTool,
    SystemPromptContributor,
    SystemPromptContributorTag,
} from "./buildSystemPrompt.ts";
export { buildSystemPrompt, filterContributorsForTools } from "./buildSystemPrompt.ts";
export { formatSkillsForSystemPrompt } from "./formatSkillsForSystemPrompt.ts";
export {
    DEFAULT_PROJECT_CONTEXT_MAX_CHARS,
    projectContextForPrompt,
    truncateByLines,
} from "./projectContext.ts";
