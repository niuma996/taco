/**
 * Run one subagent turn on the user's local Claude Code CLI via the Agent SDK.
 *
 * Counterpart to `runAttachedSubagent` for `runtime: claude-code`: there is no
 * pi harness, so this drives the SDK stream itself, persists the transcript
 * into the already-created child session, and reports the same
 * `{ resultText, isError }` shape. Never throws.
 *
 * Security posture, verified against SDK 0.3.295 + CLI 2.1.295:
 *  - `tools` is an exact allowlist of read-only tools, so the child cannot
 *    write, run commands, or spawn its own subagents.
 *  - In-workspace reads are auto-allowed by the CLI; anything that reaches
 *    `canUseTool` (reads outside cwd) is denied, keeping it in the workspace.
 *  - `settingSources: ["user"]` is required for the CLI to find the user's own
 *    login when the sidecar was started without `ANTHROPIC_*` in its env. It
 *    also loads the user's MCP servers, which `strictMcpConfig` turns off.
 *  - The env is `scrubbedProcessEnv()`: provider keys taco injected never reach
 *    the CLI. Claude Code authenticates with its own configuration.
 */

import type { SessionId, SubagentProgressDetails } from "@taco-ai/protocol";
import type { SubagentProgressSink } from "../../../agents/types.ts";
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

/** Claude Code's read-only tools. Names are Claude Code's, not taco's. */
export const CLAUDE_CODE_READONLY_TOOLS = ["Read", "Grep", "Glob"];

/** Turn cap when the agent definition sets none; mirrors the `explorer` builtin. */
export const DEFAULT_CLAUDE_CODE_MAX_TURNS = 30;

const DENY_MESSAGE = "Denied: this subagent is read-only and limited to the workspace directory.";

export interface RunClaudeCodeSubagentArgs {
    readonly subSessionId: SessionId;
    readonly agentType: string;
    readonly prompt: string;
    /** md body of the agent definition, appended to Claude Code's own system prompt. */
    readonly rolePrompt?: string;
    readonly maxTurns?: number;
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
): Promise<{ subSessionId: SessionId; resultText: string; isError: boolean }> {
    const { subSessionId, agentType } = args;
    const fail = (resultText: string) => ({ subSessionId, resultText, isError: true });
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
    if (signal.aborted) return fail(SUBAGENT_STOPPED_TEXT);

    const maxTurns =
        args.maxTurns !== undefined && args.maxTurns > 0
            ? args.maxTurns
            : DEFAULT_CLAUDE_CODE_MAX_TURNS;
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
                permissionMode: "default",
                persistSession: false,
                strictMcpConfig: true,
                mcpServers: {},
                tools: CLAUDE_CODE_READONLY_TOOLS,
                maxTurns,
                abortController: args.abortController,
                env: scrubbedProcessEnv(),
                systemPrompt: {
                    type: "preset",
                    preset: "claude_code",
                    ...(args.rolePrompt ? { append: args.rolePrompt } : {}),
                },
                canUseTool: async () => ({ behavior: "deny", message: DENY_MESSAGE }),
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

    if (signal.aborted) return fail(SUBAGENT_STOPPED_TEXT);
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
