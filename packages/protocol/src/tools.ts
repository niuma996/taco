/**
 * Catalog RPC types — tools.list, skills.list, skills.content, agents.*,
 * askUser payload, subagent.spawned push. All workspace-scoped.
 */

import type { SessionId, ToolCallId, WorkspaceId } from "./frames.js";

// tools.list

/** `tools.list` RPC params. */
export interface ToolsListParams {
    workspace: WorkspaceId;
}

/** One tool entry in the `tools.list` result. */
export interface ToolEntry {
    name: string;
    label: string;
    description: string;
    /**
     * Tool ownership:
     *  - "builtin"  — taco built-in (read/write/edit/grep/glob/bash/memory/taskCreate+taskUpdate+taskList+todoWrite/planEnter+planExit/askUser)
     *  - "external" — registered by an extension; may override a same-named built-in
     *  - "session"  — meta-tools injected only on the main session (currently: agent / skill)
     */
    category: "builtin" | "external" | "session" | "mcp";
    /** JSON Schema for the tool's params (TSchema-serialized as a plain object). */
    inputSchema?: unknown;
    /**
     * Whether depth-1 subagents can reach this tool given the configured
     * agent set:
     *  - true  — allowlisted (including "all")
     *  - false — explicitly excluded, or a recursion-guard target ("agent")
     *  - undefined — no agent configuration in workspace
     *
     * A conservatively optimistic signal for the UI; treat as a hint, not a
     * hard reachability guarantee.
     */
    availableInSubagent?: boolean;
    /** Origin of the tool. Set for tools registered via the deferred-tool
     *  registry (currently MCP), absent for the static workspace/session
     *  surface. Lets the UI distinguish "where this tool came from" without
     *  parsing the `name` prefix. */
    source?: "builtin" | "mcp";
    /** Loading mode for deferred-registry tools. "always" candidates are
     *  attached at session start; "deferred" candidates are loaded on demand
     *  via the addTools meta-tool. Set together with `source`. */
    loading?: "always" | "deferred";
}

/** `tools.list` RPC result. */
export interface ToolsListResult {
    tools: ToolEntry[];
}

// skills.list

/** `skills.list` RPC params. */
export interface SkillsListParams {
    workspace: WorkspaceId;
}

/** One skill entry in the `skills.list` result. */
export interface SkillEntry {
    name: string;
    description: string;
    filePath: string;
    /** Aligned with `AgentEntry.source` — "builtin" comes from the sidecar's built-in directory,
     *  "user" is aggregated from the four user directories. */
    source: "builtin" | "user";
    /**
     * When true, `formatSkillsForSystemPrompt` filters this skill out of
     * the system prompt, but the skill is still invokable explicitly.
     * UI uses this to flag "invisible to the model" so users aren't
     * confused by a list entry that the model never seems to call.
     */
    disableModelInvocation?: boolean;
    /**
     * Mirrors `SkillFrontmatter.inlineOnly`. When true, the skill cannot
     * run inside a subagent — `skillTool` and `agentSpawner.spawnSkillSubagent`
     * both refuse subagent-mode invocation. UI surfaces this so users see
     * the constraint, not a confusing tool error on first try.
     */
    inlineOnly?: boolean;
}

/**
 * Why a skill file failed to load, or loaded but is malformed or shadowed.
 *
 * The first five mirror pi-agent-core's `SkillDiagnosticCode` exactly (it does
 * not export a wire-safe copy). The rest are taco-added:
 *  - `duplicate_name`: pi's loader does not dedupe, so same-name collisions
 *    across the five search dirs are detected by `dedupeSkillsByName` and have
 *    no pi counterpart.
 *  - the `runAs` / `inlineOnly` / `allowedTools` codes: pi ignores these
 *    taco-private frontmatter keys entirely, so a bad value loads cleanly and
 *    only surfaces at call time. taco re-parses frontmatter at load (see
 *    checkSkillFrontmatter) and reports them here.
 */
export type SkillDiagnosticCode =
    | "file_info_failed"
    | "list_failed"
    | "read_failed"
    | "parse_failed"
    | "invalid_metadata"
    | "duplicate_name"
    | "unknown_run_as"
    | "invalid_inline_only"
    | "inline_only_conflict"
    | "invalid_allowed_tools"
    | "empty_allowed_tools";

/** One skill load-time warning, surfaced through `skills.list`. */
export interface SkillDiagnosticEntry {
    code: SkillDiagnosticCode;
    message: string;
    /** Absolute path of the offending file or directory. */
    path: string;
    /** Which search root it came from. Absent when taco synthesized the entry. */
    source?: "builtin" | "user";
    /** Set on `duplicate_name`: the colliding skill name. */
    skillName?: string;
    /** Set on `duplicate_name`: path of the entry that won, i.e. what shadowed `path`. */
    shadowedBy?: string;
}

/** `skills.list` RPC result. */
export interface SkillsListResult {
    skills: SkillEntry[];
    /**
     * Load-time warnings for files that failed to parse or were shadowed.
     * Omitted (not `[]`) when there are none, so clients written before this
     * field existed are unaffected.
     */
    diagnostics?: SkillDiagnosticEntry[];
}

// skills.content

/** `skills.content` RPC params — `filePath` comes from the `skills.list` result. */
export interface SkillContentParams {
    workspace: WorkspaceId;
    filePath: string;
}

/** `skills.content` RPC result. */
export interface SkillContentResult {
    content: string;
}

// agents.list / subagent.spawned

/** `agents.list` RPC params. */
export interface AgentsListParams {
    workspace: WorkspaceId;
}

/**
 * Engine that runs an agent. UI/config only — the model always delegates by
 * agent name and never sees this. Absent = "standard" (taco's own harness).
 */
export type AgentRuntime = "standard" | "claude-code";

/** Available agent type entry. */
export interface AgentEntry {
    agentType: string;
    description: string;
    whenToUse?: string;
    /** Context mode from the definition's frontmatter; absent = "independent". */
    context?: "independent" | "fork";
    /** Engine from the definition's frontmatter; absent = "standard". UI-only, never model-visible. */
    runtime?: AgentRuntime;
    source: "builtin" | "user";
    /** Whether `agents.write` / `agents.delete` may modify this definition. */
    editable: boolean;
}

/** `agents.list` RPC result. */
export interface AgentsListResult {
    agents: AgentEntry[];
}

/** `agents.content` RPC params — only `agentType` is required. */
export interface AgentsContentParams {
    workspace: WorkspaceId;
    agentType: string;
}

/** `agents.content` RPC result — the agent's system prompt (md body, frontmatter stripped). */
export interface AgentsContentResult {
    agentType: string;
    systemPrompt: string;
    description: string;
    whenToUse?: string;
    /** Context mode from the definition's frontmatter; absent = "independent". */
    context?: "independent" | "fork";
    runtime?: AgentRuntime;
    maxTurns?: number;
    source: "builtin" | "user";
    editable: boolean;
}

/**
 * `agents.write` RPC params — create or overwrite one agent definition in
 * `$TACO_HOME/agents/<agentType>.md`.
 */
export interface AgentsWriteParams {
    workspace: WorkspaceId;
    agentType: string;
    description: string;
    whenToUse?: string;
    /** Omitted = "standard"; the file then carries no `runtime:` line. */
    runtime?: AgentRuntime;
    maxTurns: number;
    systemPrompt: string;
    /**
     * Set when editing: the agentType being replaced. Renaming deletes the old
     * file once the new one is written. Absent = create, which fails if the
     * agentType already exists in any source.
     */
    previousAgentType?: string;
}

export interface AgentsWriteResult {
    ok: true;
}

/** `agents.delete` RPC params — only editable (`$TACO_HOME/agents`) definitions. */
export interface AgentsDeleteParams {
    workspace: WorkspaceId;
    agentType: string;
}

export interface AgentsDeleteResult {
    ok: true;
}

/** `subagent.spawned` push params. */
export interface SubagentSpawnedPayload {
    parentSessionId: SessionId;
    parentToolCallId: string;
    subSessionId: SessionId;
    agentType: string;
}

/**
 * `subagent.settled` push params — a `background: true` subagent reached a
 * terminal state.
 *
 * Needed because a background spawn's `tool_call_end` fires at *launch*, not
 * at completion: consumers that treated that event as "the child is done"
 * (the pre-background invariant) have no other signal that it stopped.
 */
export interface SubagentSettledPayload {
    parentSessionId: SessionId;
    parentToolCallId: string;
    subSessionId: SessionId;
    agentType: string;
    /**
     * `aborted` — the run was stopped deliberately (user stop via the panel /
     * `agentAbort`, or its own wall-clock timeout), which is not a failure.
     */
    outcome: "completed" | "error" | "aborted";
}

/**
 * Shape of the `details` field on the `agent` tool's **final** result.
 *
 * Discriminated by `status`:
 *  - `"completed"` — the subagent ran to completion (or failed) synchronously,
 *    and `content` carries its final answer. `subSessionId` is absent when the
 *    spawn failed before a child session existed (e.g. unknown agentType) —
 *    consumers must treat it as optional rather than assuming a string is
 *    always present.
 *  - `"launched"` — `background: true` was requested; the child session was
 *    created and is running, but `content` is a receipt, not an answer. The
 *    real result arrives later as an injected message in the parent session
 *    (see `subagentDelivery.ts`), not through this tool result.
 *
 * A final result never carries `turns`: that field belongs to
 * {@link SubagentProgressDetails} and its absence here is what lets a consumer
 * tell a finished card from a running one.
 */
export type AgentToolDetails =
    | { status: "completed"; subSessionId?: SessionId; agentType: string }
    | { status: "launched"; subSessionId: SessionId; agentType: string }
    | { status: "error"; agentType: string };

/**
 * Shape of the `details` field on a subagent tool's **live progress** update
 * (`agent`, `agentContinue`, and subagent-mode `skill` all publish this).
 *
 * Deliberately separate from {@link AgentToolDetails}: progress and final
 * results travel the same tool card but mean different things, and only
 * progress has a turn counter. Structural compatibility is intentional — the
 * desktop overwrites the card's details on each update, so a progress frame
 * must still satisfy whatever the final shape's consumers read.
 */
export interface SubagentProgressDetails {
    subSessionId: SessionId;
    /** `explorer` / `reviewer` for the agent tool; `skill:<name>` for a skill subagent. */
    agentType: string;
    /** Completed turns so far. Absent on the first (pre-run) update. */
    turns?: number;
}

/** Shape of the `details` field on the `agentContinue` tool's result. */
export interface AgentContinueToolDetails {
    subSessionId: SessionId;
}

// askUser tool

/** One option. */
export interface QuestionOption {
    label: string;
    description: string;
    preview?: string;
}

/** One question. */
export interface AskUserQuestion {
    question: string;
    header: string;
    options: QuestionOption[];
    multiSelect: boolean;
}

/** `askUser` tool params. */
export interface AskUserParams {
    questions: AskUserQuestion[];
    /**
     * question text → chosen answer.
     * Single-select: label string. Multi-select: label array.
     * Arrays tolerate labels containing commas / special characters, which
     * CSV-joining would mangle.
     */
    answers?: Record<string, string | string[]>;
    annotations?: Record<string, { preview?: string; notes?: string }>;
    metadata?: { source?: string };
}

/** `askUser` tool result.details shape. */
export interface AskUserToolDetails {
    questions?: AskUserQuestion[];
    answers?: Record<string, string | string[]>;
    waiting?: boolean;
}

/**
 * `session.submitAnswers` RPC params — the client hands the askUser
 * answers directly to the sidecar, which constructs the
 * `<ask_user_context>` tag and injects it into the user message. Clients
 * no longer need to know the wire format of that tag. `toolCallId`
 * verifies the askUser call is still in the waiting state.
 */
export interface SubmitAnswersParams {
    workspace: WorkspaceId;
    sessionId: SessionId;
    toolCallId: ToolCallId;
    answers: Record<string, string | string[]>;
    /** Aligned with `AskUserPayload.toolName`; defaults to "askUser". */
    toolName?: string;
}
