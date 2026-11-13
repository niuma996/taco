/**
 * Run one Codex subagent turn through the optional SDK. This runner owns the
 * native thread, transcript, abort distinction, and resumable-state callback;
 * conversation queueing and spawn/resume integration live above it.
 */

import type { SessionId, SubagentProgressDetails } from "@taco-ai/protocol";
import type { CodexAgentConfig, SubagentProgressSink } from "../../../agents/types.ts";
import { createLogger } from "../../../lib/logger.ts";
import { scrubbedProcessEnv } from "../../models/providerKeyStore.ts";
import type { AgentMessage, AgentToolResult } from "../../pi/types.ts";
import {
    failedResult,
    isSubagentTimeoutReason,
    SUBAGENT_STOPPED_TEXT,
    subagentStartedResult,
    subagentTimeoutText,
    subagentTurnResult,
} from "../subagentProgress.ts";
import { type CodexSdkModule, type CodexThreadOptions, createCodexClient } from "./codexSdk.ts";
import { CodexTranscript } from "./codexTranscript.ts";

const log = createLogger("sidecar.codexRunner");

export interface RunCodexSubagentArgs {
    readonly subSessionId: SessionId;
    readonly agentType: string;
    readonly prompt: string;
    readonly resumeThreadId?: string;
    readonly onThreadId?: (id: string) => Promise<void>;
    readonly rolePrompt?: string;
    readonly config?: CodexAgentConfig;
    readonly mcpServers?: Record<string, Record<string, unknown>>;
    readonly cwd: string;
    readonly skipGitRepoCheck?: boolean;
    readonly abortController: AbortController;
    readonly onUpdate?: SubagentProgressSink;
    readonly appendMessages: (messages: AgentMessage[]) => Promise<void>;
    /** Test seam; production dynamically loads the pinned SDK. */
    readonly loadSdk?: () => Promise<CodexSdkModule>;
}

export interface CodexRunResult {
    subSessionId: SessionId;
    resultText: string;
    isError: boolean;
    aborted?: boolean;
    partial?: boolean;
}

function threadOptions(args: RunCodexSubagentArgs): CodexThreadOptions {
    return {
        workingDirectory: args.cwd,
        threadSource: "taco",
        // Absent = the user's own Codex configuration decides.
        ...(args.config?.model ? { model: args.config.model } : {}),
        ...(args.config?.sandbox !== undefined ? { sandboxMode: args.config.sandbox } : {}),
        ...(args.config?.approvalPolicy !== undefined
            ? { approvalPolicy: args.config.approvalPolicy }
            : {}),
        ...(args.skipGitRepoCheck ? { skipGitRepoCheck: true } : {}),
    };
}

/** Run one fresh/resumed Codex turn. Never throws. */
export async function runCodexSubagent(args: RunCodexSubagentArgs): Promise<CodexRunResult> {
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
        try {
            args.onUpdate?.(payload as AgentToolResult<never>, options);
        } catch (error) {
            log.warn("codex progress callback failed", {
                subSessionId,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    };

    if (args.resumeThreadId !== undefined) {
        const resumeThreadId = args.resumeThreadId.trim();
        if (resumeThreadId === "" || resumeThreadId !== args.resumeThreadId) {
            return fail(
                "Codex resume state is invalid: the saved native thread id is empty or malformed. " +
                    "Create a fresh agent explicitly instead of overwriting the conversation mapping.",
            );
        }
    }
    publish(
        subagentStartedResult({
            subSessionId,
            agentType,
            resumability: args.resumeThreadId ? "resumable" : "not_resumable",
        }),
        { checkpoint: true },
    );
    const signal = args.abortController.signal;
    if (signal.aborted) {
        const reason = signal.reason;
        return fail(
            isSubagentTimeoutReason(reason)
                ? subagentTimeoutText({ timeoutMinutes: reason.timeoutMinutes, turnsUsed: 0 })
                : SUBAGENT_STOPPED_TEXT,
            true,
        );
    }
    let savedThreadId = args.resumeThreadId;
    let writes: Promise<void> = Promise.resolve();
    let writeError: string | undefined;
    const persist = (messages: AgentMessage[]): void => {
        if (messages.length === 0) return;
        writes = writes
            .then(() => args.appendMessages(messages))
            .catch((error: unknown) => {
                writeError ??= error instanceof Error ? error.message : String(error);
                log.warn("failed to persist codex transcript", {
                    subSessionId,
                    error: error instanceof Error ? error.message : String(error),
                });
            });
    };

    persist([{ role: "user", content: args.prompt, timestamp: Date.now() }]);
    const transcript = new CodexTranscript();
    let turns = 0;
    let streamError: string | undefined;
    let completed = false;
    let thrown: unknown;

    try {
        await writes;
        if (writeError !== undefined) {
            throw new Error(`failed to persist the Codex prompt: ${writeError}`);
        }
        const sdk = await (args.loadSdk?.() ??
            import("./codexSdk.ts").then((m) => m.loadCodexSdk()).then((m) => m.module));
        const config: Record<string, unknown> = {};
        if (args.rolePrompt) config.developer_instructions = args.rolePrompt;
        if (args.mcpServers) config.mcp_servers = args.mcpServers;
        const codex = createCodexClient(sdk, {
            env: scrubbedProcessEnv(),
            ...(Object.keys(config).length > 0 ? { config } : {}),
        });
        const options = threadOptions(args);
        const thread = savedThreadId
            ? codex.resumeThread(savedThreadId, options)
            : codex.startThread(options);
        const stream = await thread.runStreamed(args.prompt, { signal });
        for await (const event of stream.events) {
            if (event.type === "thread.started" && event.thread_id) {
                if (args.resumeThreadId && event.thread_id !== args.resumeThreadId) {
                    streamError =
                        `Codex resumed thread ${args.resumeThreadId} reported a different native thread ` +
                        `${event.thread_id}; refusing to overwrite the saved conversation mapping.`;
                    break;
                }
                if (!args.resumeThreadId && event.thread_id !== savedThreadId) {
                    if (args.onThreadId) {
                        await args.onThreadId(event.thread_id);
                        savedThreadId = event.thread_id;
                        publish(
                            subagentStartedResult({
                                subSessionId,
                                agentType,
                                resumability: "resumable",
                            }),
                            { checkpoint: true },
                        );
                    }
                }
                continue;
            }
            if (event.type === "turn.completed") {
                completed = true;
                continue;
            }
            if (event.type === "turn.failed") {
                streamError = event.error?.message ?? "Codex turn failed";
                break;
            }
            if (event.type === "error") {
                streamError = event.message ?? "Codex stream failed";
                break;
            }
            const messages = transcript.push(event);
            if (messages.length > 0) {
                persist(messages);
                for (const message of messages) {
                    if (message.role !== "assistant") continue;
                    const hasText = message.content.some((entry) => entry.type === "text");
                    if (!hasText) continue;
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
            }
        }
        persist(transcript.flush());
    } catch (error) {
        thrown = error;
    }
    await writes;

    if (signal.aborted) {
        const reason = signal.reason;
        return fail(
            isSubagentTimeoutReason(reason)
                ? subagentTimeoutText({ timeoutMinutes: reason.timeoutMinutes, turnsUsed: turns })
                : SUBAGENT_STOPPED_TEXT,
            true,
        );
    }

    const lastText = transcript.lastAssistantText;
    const failAfter = (error: string) =>
        fail(
            failedResult({
                error,
                subSessionId,
                turns,
                lastText,
                resumability: savedThreadId ? "resumable" : "not_resumable",
            }),
        );
    if (thrown !== undefined)
        return failAfter(thrown instanceof Error ? thrown.message : String(thrown));
    if (writeError !== undefined)
        return failAfter(`failed to persist Codex transcript: ${writeError}`);
    if (streamError !== undefined) return failAfter(streamError);
    if (!completed) return failAfter("Codex ended without completing a turn");
    if (lastText.trim() === "") return fail("subagent returned an empty response");
    return { subSessionId, resultText: lastText, isError: false };
}
