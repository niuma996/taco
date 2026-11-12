/**
 * Run one subagent turn on the user's local Claude Code CLI via the Agent SDK.
 *
 * Counterpart to `runAttachedSubagent` for `runtime: claude-code`: no pi
 * harness, so this drives the SDK stream and persists the transcript into the
 * child session. Never throws.
 *
 * taco only launches Claude Code; what the child may do is Claude Code's own
 * permission system's call. `permissionPrompts: "none"` denies every prompt
 * in-process — taco has no surface to answer one — and `disallowedTools` keeps
 * a definition's tool list from re-adding AskUserQuestion. `settingSources:
 * ["user"]` lets the CLI find the user's login; `strictMcpConfig` keeps their
 * MCP servers out. The env drops provider keys injected by taco; user-supplied
 * env keys remain. Files Claude Code writes bypass taco's file tools, so
 * checkpoints miss them.
 */

import { randomUUID } from "node:crypto";
import type { SessionId, SubagentProgressDetails } from "@taco-ai/protocol";
import type { ClaudeCodePermissionMode, SubagentProgressSink } from "../../../agents/types.ts";
import { createLogger } from "../../../lib/logger.ts";
import { scrubbedProcessEnv } from "../../models/providerKeyStore.ts";
import type { AgentMessage, AgentToolResult } from "../../pi/types.ts";
import {
    failedResult,
    isSubagentTimeoutReason,
    partialResult,
    SUBAGENT_STOPPED_TEXT,
    subagentStartedResult,
    subagentTimeoutText,
    subagentTurnResult,
} from "../subagentProgress.ts";
import {
    type ClaudeCodeCommunicationTools,
    claudeCodeCommunicationAllowedTools,
    createClaudeCodeCommunicationServer,
} from "./claudeCodeCommunication.ts";
import { ClaudeCodeInput, type ClaudeCodeInputHandle } from "./claudeCodeInput.ts";
import {
    type ClaudeAgentSdk,
    ClaudeCodeCliMissingError,
    findClaudeExecutable,
    loadClaudeAgentSdk,
} from "./claudeCodeSdk.ts";
import { ClaudeCodeTranscript } from "./claudeCodeTranscript.ts";

export type { ClaudeCodeCommunicationTools } from "./claudeCodeCommunication.ts";
export type { ClaudeCodeInputHandle } from "./claudeCodeInput.ts";

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
export const DEFAULT_CLAUDE_CODE_MAX_TURNS = 100;

export interface RunClaudeCodeSubagentArgs {
    readonly subSessionId: SessionId;
    readonly agentType: string;
    readonly prompt: string;
    readonly resumeSessionId?: string;
    readonly onSessionId?: (id: string) => Promise<void>;
    readonly onInputReady?: (handle: ClaudeCodeInputHandle) => void;
    readonly communicationTools?: ClaudeCodeCommunicationTools;
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
    if (signal.aborted) {
        const reason = signal.reason;
        return fail(
            isSubagentTimeoutReason(reason)
                ? subagentTimeoutText({
                      timeoutMinutes: reason.timeoutMinutes,
                      turnsUsed: 0,
                  })
                : SUBAGENT_STOPPED_TEXT,
            true,
        );
    }

    const maxTurns =
        args.maxTurns !== undefined && args.maxTurns > 0
            ? args.maxTurns
            : DEFAULT_CLAUDE_CODE_MAX_TURNS;
    const permissionMode = args.permissionMode ?? DEFAULT_CLAUDE_CODE_PERMISSION_MODE;
    const transcript = new ClaudeCodeTranscript();
    let turns = 0;
    let result: { subtype: string; isError: boolean; text: string; lastText: string } | undefined;
    let savedSessionId: string | undefined;
    let hasReply = false;
    // Appends are chained so the transcript lands in order even though the
    // SDK stream does not wait for them.
    let writes: Promise<void> = Promise.resolve();
    const persist = (messages: AgentMessage[]): void => {
        if (messages.length === 0) return;
        writes = writes
            .then(() => args.appendMessages(messages))
            .catch((e: unknown) => {
                log.warn("failed to persist claude-code transcript", {
                    subSessionId,
                    error: e instanceof Error ? e.message : String(e),
                });
            });
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

    const input = new ClaudeCodeInput((prompt) => {
        // An input can arrive between chunks of one assistant reply; keep that reply intact.
        persist([{ role: "user", content: prompt, timestamp: Date.now() }]);
    });
    input.send(args.prompt, randomUUID());
    const closeInput = () => input.close();
    signal.addEventListener("abort", closeInput, { once: true });
    let stream: ReturnType<ClaudeAgentSdk["query"]> | undefined;
    let communication: ReturnType<typeof createClaudeCodeCommunicationServer> | undefined;
    let thrown: unknown;
    try {
        if (args.communicationTools) {
            communication = createClaudeCodeCommunicationServer(args.communicationTools);
        }
        stream = sdk.query({
            prompt: input,
            options: {
                pathToClaudeCodeExecutable: executable,
                cwd: args.cwd,
                settingSources: ["user"],
                ...(permissionMode === "inherit" ? {} : { permissionMode }),
                ...(permissionMode === "bypassPermissions"
                    ? { allowDangerouslySkipPermissions: true }
                    : {}),
                permissionPrompts: "none",
                persistSession: true,
                ...(args.resumeSessionId !== undefined ? { resume: args.resumeSessionId } : {}),
                strictMcpConfig: true,
                mcpServers: communication ? { taco: communication } : {},
                ...(args.communicationTools
                    ? { allowedTools: claudeCodeCommunicationAllowedTools(args.communicationTools) }
                    : {}),
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
        args.onInputReady?.(input);
        for await (const frame of stream) {
            if (
                frame.type === "system" &&
                frame.subtype === "init" &&
                frame.session_id &&
                args.onSessionId &&
                frame.session_id !== savedSessionId
            ) {
                await args.onSessionId(frame.session_id);
                savedSessionId = frame.session_id;
                publish(
                    subagentStartedResult({ subSessionId, agentType, resumability: "resumable" }),
                    {
                        checkpoint: true,
                    },
                );
            }
            if (
                frame.type === "assistant" &&
                frame.message.content.some((block) => block.type === "text" && block.text?.trim())
            )
                hasReply = true;
            persist(transcript.push(frame));
            if (frame.type === "result") {
                persist(transcript.flush());
                result = {
                    subtype: frame.subtype,
                    isError: frame.is_error,
                    text: frame.result ?? frame.errors?.join("\n") ?? "",
                    lastText: hasReply ? transcript.lastAssistantText : "",
                };
                hasReply = false;
                input.complete(frame);
            }
        }
        input.finish();
    } catch (e) {
        thrown = e;
    } finally {
        input.close();
        signal.removeEventListener("abort", closeInput);
        try {
            stream?.close?.();
        } catch (e) {
            thrown ??= e;
        }
        try {
            await communication?.instance.close();
        } catch (e) {
            thrown ??= e;
        }
    }
    persist(transcript.flush());
    await writes;

    if (signal.aborted) {
        const reason = signal.reason;
        return fail(
            isSubagentTimeoutReason(reason)
                ? subagentTimeoutText({
                      timeoutMinutes: reason.timeoutMinutes,
                      turnsUsed: turns,
                  })
                : SUBAGENT_STOPPED_TEXT,
            true,
        );
    }
    const lastText = transcript.lastAssistantText;
    // A run can fail after real work (an API error mid-task), so the failure
    // carries how far it got and offers recovery only after the host saved the ID.
    const failAfter = (error: string) =>
        fail(
            failedResult({
                error,
                subSessionId,
                turns,
                lastText,
                resumability: savedSessionId ? "resumable" : "not_resumable",
            }),
        );
    if (thrown !== undefined)
        return failAfter(thrown instanceof Error ? thrown.message : String(thrown));
    if (result?.subtype === "error_max_turns") {
        return {
            subSessionId,
            resultText: partialResult(result.lastText, maxTurns),
            isError: false,
        };
    }
    if (result === undefined) return failAfter("Claude Code ended without a result");
    // The CLI reports some failures (e.g. "Not logged in") as a successful
    // result whose text is the error, with no assistant reply to read.
    if (result.isError || result.subtype !== "success") {
        return failAfter(result.text || `Claude Code failed: ${result.subtype}`);
    }
    if (result.lastText.trim() === "") return fail("subagent returned an empty response");
    return { subSessionId, resultText: result.lastText, isError: false };
}
