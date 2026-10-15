/**
 * Run one subagent turn on the user's local Claude Code CLI via the Agent SDK.
 *
 * Counterpart to `runAttachedSubagent` for `runtime: claude-code`: there is no
 * pi harness, so this drives the SDK stream itself, persists the transcript
 * into the already-created child session, and reports the same
 * `{ resultText, isError }` shape. Never throws.
 *
 * taco only launches Claude Code; what the child may do is Claude Code's own
 * permission system's call, not taco's. Verified against SDK 0.3.299 + CLI
 * 2.1.295:
 *  - `tools` defaults to Claude Code's full preset (write, shell, web
 *    included); a definition may narrow it to an explicit list.
 *  - `permissionMode` defaults to `auto` (Claude Code's classifier approves or
 *    denies each call). `inherit` passes none, so the user's
 *    `permissions.defaultMode` decides.
 *  - `permissionPrompts: "none"`: taco has no surface to answer a Claude Code
 *    permission prompt, so anything that would prompt is denied in-process
 *    with a message telling Claude so. AskUserQuestion is additionally
 *    blocked via `disallowedTools` so a definition's explicit tool list
 *    cannot re-add it — the subagent reports decisions back instead of
 *    asking. This is the interim stance until prompts can be proxied to the
 *    parent session.
 *  - `settingSources: ["user"]` is required for the CLI to find the user's own
 *    login when the sidecar was started without `ANTHROPIC_*` in its env. It
 *    also loads the user's MCP servers, which `strictMcpConfig` turns off.
 *  - The env is `scrubbedProcessEnv()`: provider keys taco injected never reach
 *    the CLI. Claude Code authenticates with its own configuration.
 *  - Files Claude Code writes bypass taco's file tools, so taco checkpoints do
 *    not cover them.
 */

import type { SessionId, SubagentProgressDetails } from "@taco-ai/protocol";
import type { ClaudeCodePermissionMode, SubagentProgressSink } from "../../../agents/types.ts";
import { createLogger } from "../../../lib/logger.ts";
import { scrubbedProcessEnv } from "../../models/providerKeyStore.ts";
import type { AgentMessage, AgentToolResult } from "../../pi/types.ts";
import {
    partialResult,
    SUBAGENT_STOPPED_TEXT,
    subagentStartedResult,
    subagentTurnResult,
} from "../subagentProgress.ts";
import {
    type ClaudeAgentSdk,
    ClaudeCodeCliMissingError,
    findClaudeExecutable,
    loadClaudeAgentSdk,
} from "./claudeCodeSdk.ts";
import { ClaudeCodeTranscript } from "./claudeCodeTranscript.ts";

const log = createLogger("sidecar.claudeCodeRunner");

/** Claude Code's own default toolset; used when a definition lists no tools. */
export const CLAUDE_CODE_TOOL_PRESET = { type: "preset", preset: "claude_code" } as const;

/**
 * Tools never handed to a Claude Code child, regardless of the definition's
 * list. AskUserQuestion would open an interactive prompt no one can answer:
 * `permissionPrompts: "none"` already drops it from the preset, and this
 * stops a definition's explicit tool list from adding it back. Verified
 * against SDK 0.3.299 + CLI 2.1.295: a disallowed tool never appears in the
 * init frame's tool list.
 */
export const CLAUDE_CODE_BLOCKED_TOOLS = ["AskUserQuestion"] as const;

/** Permission mode when a definition names none. */
export const DEFAULT_CLAUDE_CODE_PERMISSION_MODE: ClaudeCodePermissionMode = "auto";

/** Turn cap when the agent definition sets none. */
export const DEFAULT_CLAUDE_CODE_MAX_TURNS = 50;

export interface RunClaudeCodeSubagentArgs {
    readonly subSessionId: SessionId;
    readonly agentType: string;
    readonly prompt: string;
    /** md body of the agent definition, appended to Claude Code's own system prompt. */
    readonly rolePrompt?: string;
    readonly maxTurns?: number;
    /** Claude Code tool names; undefined = Claude Code's full preset. */
    readonly tools?: readonly string[];
    readonly permissionMode?: ClaudeCodePermissionMode;
    readonly cwd: string;
    readonly abortController: AbortController;
    readonly onUpdate?: SubagentProgressSink;
    /** Append messages to the child session's main branch, in order. */
    readonly appendMessages: (messages: AgentMessage[]) => Promise<void>;
    /** Test seam; production loads the optional SDK package. */
    readonly loadSdk?: () => Promise<ClaudeAgentSdk>;
    /** Test seam; production searches PATH. */
    readonly findExecutable?: () => string | undefined;
}

export async function runClaudeCodeSubagent(
    args: RunClaudeCodeSubagentArgs,
): Promise<{ subSessionId: SessionId; resultText: string; isError: boolean; aborted?: boolean }> {
    const { subSessionId, agentType } = args;
    const fail = (resultText: string, aborted = false) => ({
        subSessionId,
        resultText,
        isError: true,
        ...(aborted ? { aborted: true } : {}),
    });
    const publish = (
        payload: AgentToolResult<SubagentProgressDetails>,
        options?: { checkpoint: true },
    ): void => {
        args.onUpdate?.(payload as AgentToolResult<never>, options);
    };

    publish(subagentStartedResult({ subSessionId, agentType, resumability: "not_resumable" }), {
        checkpoint: true,
    });

    let sdk: ClaudeAgentSdk;
    try {
        sdk = await (args.loadSdk ?? loadClaudeAgentSdk)();
    } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
    }
    const executable = (args.findExecutable ?? findClaudeExecutable)();
    if (executable === undefined) return fail(new ClaudeCodeCliMissingError().message);

    const signal = args.abortController.signal;
    if (signal.aborted) return fail(SUBAGENT_STOPPED_TEXT, true);

    const maxTurns =
        args.maxTurns !== undefined && args.maxTurns > 0
            ? args.maxTurns
            : DEFAULT_CLAUDE_CODE_MAX_TURNS;
    const permissionMode = args.permissionMode ?? DEFAULT_CLAUDE_CODE_PERMISSION_MODE;
    const transcript = new ClaudeCodeTranscript();
    let turns = 0;
    let result: { subtype: string; isError: boolean; text: string } | undefined;
    // Appends are chained so the transcript lands in order even though the
    // SDK stream does not wait for them.
    let writes: Promise<void> = args.appendMessages([
        { role: "user", content: args.prompt, timestamp: Date.now() },
    ]);
    const persist = (messages: AgentMessage[]): void => {
        if (messages.length === 0) return;
        writes = writes.then(() => args.appendMessages(messages));
        for (const m of messages) {
            if (m.role !== "assistant") continue;
            turns++;
            publish(
                subagentTurnResult({
                    subSessionId,
                    agentType,
                    turns,
                    lastText: transcript.lastAssistantText,
                }),
            );
        }
    };

    let thrown: unknown;
    try {
        const stream = sdk.query({
            prompt: args.prompt,
            options: {
                pathToClaudeCodeExecutable: executable,
                cwd: args.cwd,
                settingSources: ["user"],
                ...(permissionMode === "inherit" ? {} : { permissionMode }),
                ...(permissionMode === "bypassPermissions"
                    ? { allowDangerouslySkipPermissions: true }
                    : {}),
                permissionPrompts: "none",
                persistSession: false,
                strictMcpConfig: true,
                mcpServers: {},
                tools: args.tools !== undefined ? [...args.tools] : CLAUDE_CODE_TOOL_PRESET,
                disallowedTools: [...CLAUDE_CODE_BLOCKED_TOOLS],
                maxTurns,
                abortController: args.abortController,
                env: scrubbedProcessEnv(),
                systemPrompt: {
                    type: "preset",
                    preset: "claude_code",
                    ...(args.rolePrompt ? { append: args.rolePrompt } : {}),
                },
                stderr: (data) => log.debug("claude stderr", { subSessionId, data }),
            },
        });
        for await (const frame of stream) {
            persist(transcript.push(frame));
            if (frame.type === "result") {
                result = {
                    subtype: frame.subtype,
                    isError: frame.is_error,
                    text: frame.result ?? frame.errors?.join("\n") ?? "",
                };
            }
        }
    } catch (e) {
        thrown = e;
    }
    persist(transcript.flush());
    try {
        await writes;
    } catch (e) {
        log.warn("failed to persist claude-code transcript", {
            subSessionId,
            error: e instanceof Error ? e.message : String(e),
        });
    }

    if (signal.aborted) return fail(SUBAGENT_STOPPED_TEXT, true);
    const lastText = transcript.lastAssistantText;
    if (result?.subtype === "error_max_turns") {
        return { subSessionId, resultText: partialResult(lastText, maxTurns), isError: false };
    }
    if (thrown !== undefined)
        return fail(thrown instanceof Error ? thrown.message : String(thrown));
    if (result === undefined) return fail("Claude Code ended without a result");
    // The CLI reports some failures (e.g. "Not logged in") as a successful
    // result whose text is the error, with no assistant reply to read.
    if (result.isError || result.subtype !== "success") {
        return fail(result.text || `Claude Code failed: ${result.subtype}`);
    }
    if (lastText.trim() === "") return fail("subagent returned an empty response");
    return { subSessionId, resultText: lastText, isError: false };
}
