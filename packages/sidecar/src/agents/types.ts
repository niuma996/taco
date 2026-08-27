/**
 * Subagent definition and spawn context types.
 * AgentDefinition is parsed from md frontmatter by loadAgents.
 * SubagentSpawnContext is the narrow interface WorkspaceRuntime injects into the agent tool.
 */

import type { SessionId } from "@taco-ai/protocol";

/**
 * How a subagent receives context from its parent session.
 *
 * - `independent` — a fresh session with no parent history. The default, and
 *   the only behavior before fork support. Correct for `explorer` /
 *   `verification`, whose value is a clean view uncolored by the parent's
 *   assumptions.
 * - `fork` — the subagent additionally sees a transcript of the parent
 *   conversation up to the fork point. Correct for roles that must judge a
 *   result against the intent that was discussed (e.g. `reviewer`).
 *
 * Fork passes context, not authority: the child's toolset, permissions, plan
 * state, and task store are all still built fresh for the child session.
 */
export type SubagentContextMode = "independent" | "fork";

/** A single example conversation turn injected ahead of the profile body. */
export interface AgentFewShot {
    /** The example user message. */
    readonly user: string;
    /** The example assistant message — must demonstrate the contract the
     *  profile is supposed to enforce (e.g. cite, return-only-text). */
    readonly assistant: string;
}

export interface AgentDefinition {
    agentType: string;
    description: string;
    whenToUse?: string;
    /** md body — used as the subagent's system prompt base */
    systemPrompt: string;
    /** Tool whitelist; undefined = inherit all parent tools (agent still removed by depth recursion guard) */
    tools?: string[];
    maxTurns?: number;
    /**
     * Context mode for this agent type. Omitted in frontmatter = "independent".
     * The `agent` tool's `context` param overrides this per-spawn.
     */
    context?: SubagentContextMode;
    /** Optional in-context examples. Injected into the child's system prompt
     *  ahead of `systemPrompt` (md body) so the examples establish tone and
     *  contract before the role body takes over. Keep total length under a
     *  few hundred tokens — these ship in every subagent prompt. */
    fewShots?: ReadonlyArray<AgentFewShot>;
    source: "builtin" | "user";
    filePath: string;
}

/** Narrow interface WorkspaceRuntime injects into the agent tool: only spawn and continue. */
export interface SubagentSpawnContext {
    /** `subSessionId` is absent when the spawn failed before a child session existed. */
    spawn(args: {
        parentToolCallId: string;
        agentType: string;
        prompt: string;
        /** Overrides the agent definition's `context` default when present. */
        context?: SubagentContextMode;
        signal?: AbortSignal;
    }): Promise<{ subSessionId?: SessionId; resultText: string; isError: boolean }>;
    /**
     * Resume an existing subagent by `subSessionId`. The caller MUST be the
     * same parent session that originally spawned it (verified via JSONL
     * metadata). Concurrent calls with the same `subSessionId` share the
     * single in-flight result.
     */
    continue(args: {
        parentToolCallId: string;
        subSessionId: SessionId;
        prompt: string;
        signal?: AbortSignal;
    }): Promise<{ subSessionId: SessionId; resultText: string; isError: boolean }>;
}
