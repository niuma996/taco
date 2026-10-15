/**
 * Subagent definition and spawn context types.
 * AgentDefinition is parsed from md frontmatter by loadAgents.
 * SubagentSpawnContext is the narrow interface WorkspaceRuntime injects into the agent tool.
 */

import type { SessionId } from "@taco-ai/protocol";
import type { AgentHarnessToolUpdateCallback } from "../runtime/pi/types.ts";

/**
 * Progress sink forwarded from a tool down to the subagent runner.
 *
 * Typed over `never`, not over a payload type: pi types a tool's updates as
 * carrying that tool's own result details, but all three subagent-backed tools
 * (`agent`, `agentContinue`, subagent-mode `skill`) share one runner and one
 * payload shape, which is not assignable to each tool's own details type.
 * Contravariance makes every tool callback assignable to this sink; the runner
 * asserts the payload it publishes (see subagentRunner).
 */
export type SubagentProgressSink = AgentHarnessToolUpdateCallback<never>;

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

/**
 * Which engine runs a subagent. Never model-visible: the model picks an agent
 * by name and the spawner dispatches on the definition's runtime.
 *
 * - `standard` — taco's own harness. The default when frontmatter omits it.
 * - `claude-code` — the whole run is delegated to the user's local Claude
 *   Code CLI through the Agent SDK: Claude Code's own tools and permission
 *   system rather than taco's, always `independent`, and not resumable with
 *   `agentContinue`.
 */
export type SubagentRuntime = "standard" | "claude-code";

/**
 * Claude Code permission mode for a `claude-code` agent. `inherit` passes no
 * mode, so Claude Code picks its own (the user's `permissions.defaultMode`,
 * else its default). Omitted in frontmatter = `auto`.
 */
export type ClaudeCodePermissionMode =
    | "auto"
    | "default"
    | "acceptEdits"
    | "plan"
    | "dontAsk"
    | "bypassPermissions"
    | "inherit";

/** Runtime assumed when a definition does not name one. */
export const DEFAULT_SUBAGENT_RUNTIME: SubagentRuntime = "standard";

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
    /**
     * Tool whitelist; undefined = inherit all parent tools (agent still removed
     * by depth recursion guard). For `claude-code` the names are Claude Code's
     * own, and undefined = its full default toolset.
     */
    tools?: string[];
    maxTurns?: number;
    /**
     * Wall-clock budget for a `background: true` spawn of this agent type, in
     * minutes. Ignored for synchronous spawns — those are already bounded by
     * the parent turn. Defaults to `DEFAULT_BACKGROUND_TIMEOUT_MS` (see
     * `agentSpawner.ts`) when omitted.
     */
    timeoutMinutes?: number;
    /**
     * Context mode for this agent type. Omitted in frontmatter = "independent".
     * The `agent` tool's `context` param overrides this per-spawn.
     */
    context?: SubagentContextMode;
    /** Engine for this agent type. Omitted in frontmatter = "standard". */
    runtime?: SubagentRuntime;
    /** `claude-code` only; ignored for other runtimes. Omitted = "auto". */
    permissionMode?: ClaudeCodePermissionMode;
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
        /**
         * The caller's short task summary. Used only on the background path, to
         * label the completion notice — by the time that notice arrives the
         * conversation may have moved on, and compaction may have collapsed the
         * tool call that would otherwise say what the subagent was for.
         */
        description?: string;
        /** Overrides the agent definition's `context` default when present. */
        context?: SubagentContextMode;
        /**
         * Run the child without blocking this call. Defaults to `false`
         * (today's behavior: await the child to completion). When `true`,
         * `spawn` resolves as soon as the child session exists — `resultText`
         * is empty and the real result is delivered later as an injected
         * message in the parent session (see `subagentDelivery.ts`). The
         * `signal` passed in this case is NOT used to cancel the child; the
         * child gets its own timeout-driven `AbortController` instead, since
         * a background run must outlive the parent turn that launched it.
         */
        background?: boolean;
        signal?: AbortSignal;
        /** Tool progress sink — forwarded from the calling tool's own `onUpdate`. */
        onUpdate?: SubagentProgressSink;
    }): Promise<{
        subSessionId?: SessionId;
        resultText: string;
        isError: boolean;
        /** A deliberate interruption; distinct from a failed run. */
        aborted?: boolean;
        /** Echoes the effective `background` mode so the tool layer knows which `AgentToolDetails` variant to report. */
        background?: boolean;
        /**
         * Where a background spawn's result will be written. Present only for a
         * launched background spawn, and known before the child produces
         * anything — the receipt carries it so the model can recover the result
         * by reading the file if the completion notice never arrives.
         */
        resultPath?: string;
    }>;
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
        /** Tool progress sink — forwarded from the calling tool's own `onUpdate`. */
        onUpdate?: SubagentProgressSink;
    }): Promise<{
        subSessionId: SessionId;
        resultText: string;
        isError: boolean;
        aborted?: boolean;
    }>;
    /**
     * Stop a running subagent by `subSessionId` without aborting the parent
     * turn. Implementations restrict this to the calling session's own
     * children. `stopped: false` means it already settled (or the id is not a
     * running child of this session). The stop is asynchronous — the outcome
     * reaches the subagent's own call through the normal settle path.
     */
    abortSubagent(args: { subSessionId: SessionId }): { stopped: boolean };
}
