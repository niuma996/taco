/**
 * shell tool — unified host shell execution.
 *
 * On non-Windows platforms it runs commands through the system shell (bash/sh).
 * On Windows it runs `powershell.exe -NoProfile -Command`. Non-zero exits are
 * returned, not thrown, so the model can decide how to respond.
 */

import type { CommandPermissionDenialReason } from "@taco-ai/protocol";
import type { Static } from "typebox";
import { Type } from "typebox";
import { denialGuidance } from "../permissions/denialGuidance.ts";
import type { PermissionBroker } from "../permissions/permissionBroker.ts";
import type {
    AgentHarnessTool,
    Context,
    ExecutionToolContext,
    TextContent,
} from "../runtime/pi/types.ts";
import { DEFAULT_TIMEOUT_MS, runShell } from "./shell.ts";

export type ShellTool = AgentHarnessTool<ExecutionToolContext>;

const shellSchema = Type.Object({
    command: Type.String({ description: "The shell command to execute." }),
    timeout: Type.Optional(
        Type.Number({ description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}).` }),
    ),
    description: Type.Optional(
        Type.String({
            description:
                "Short description of what this command does; shown in the desktop tool card, not executed.",
        }),
    ),
});

type ShellToolResult = {
    content: TextContent[];
    details: {
        exitCode: number;
        interrupted: boolean;
        reason?:
            | "permission_denied"
            | "permission_timeout"
            | "permission_aborted"
            | "permission_no_approver"
            | "permission_im_channel";
    };
    isError: boolean;
};

/**
 * Build the denial result for a `CommandPermissionDecision`.
 *
 * The text is shared with every other tool that goes through the permission
 * broker (see `permissions/denialGuidance.ts`) — a model that learns "a
 * denial is final" from one tool should not have to relearn it from
 * another.
 *
 * A `user_denied` routes the model to `askUser`, with a fallback for
 * subagents (which have no `askUser` — this tool cannot tell which kind of
 * session it runs in); an `undefined` reason means the command was blocked
 * by policy before any UI (deny rule, read-only broker, IM channel), where
 * there is no user to ask — so that path explains and stops instead.
 */
function deniedResult(reason: CommandPermissionDenialReason | undefined): ShellToolResult {
    const text = denialGuidance(reason, {
        action: "this command",
        alternativeRoutes:
            "a different command, a pipeline, or another tool (`write`/`edit`) that has the same effect",
    });
    return {
        content: [{ type: "text", text }],
        details: { exitCode: -1, interrupted: false, reason: denialReasonCode(reason) },
        isError: true,
    };
}

/** The machine-readable denial code carried in the tool result's details. */
function denialReasonCode(
    reason: CommandPermissionDenialReason | undefined,
): ShellToolResult["details"]["reason"] {
    if (reason === "timeout") return "permission_timeout";
    if (reason === "aborted") return "permission_aborted";
    if (reason === "no_approver") return "permission_no_approver";
    if (reason === "im_channel") return "permission_im_channel";
    return "permission_denied";
}

export type ShellToolInput = Static<typeof shellSchema>;

/**
 * Prefix a PowerShell command with statements that force UTF-8 output.
 *
 * Windows consoles default to the OEM code page (cp936/GBK on zh-CN, cp437 on
 * en-US). Without this, PowerShell writes non-UTF-8 bytes — including
 * localised error text like "无法将 'x' 项识别为..." — which the sidecar then
 * decodes as UTF-8, producing mojibake. Setting `[Console]::OutputEncoding`
 * makes PowerShell and the native commands it launches emit UTF-8, so the
 * sidecar's UTF-8 decode (see shell.ts) is correct.
 *
 * `chcp` is intentionally omitted: it changes the console code page, which has
 * no effect when stdout is a pipe (as it is here). Setting the .NET encoding
 * objects is the mechanism that actually works for piped output.
 *
 * Windows-only. Unix commands run unchanged through the other runShell branch.
 */
function withUtf8Output(command: string): string {
    const preamble =
        "$OutputEncoding = [System.Text.Encoding]::UTF8; " +
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ";
    return preamble + command;
}

function getShellDescription(): string {
    if (process.platform === "win32") {
        return "Execute a PowerShell command on Windows. Output is truncated at 1MB, timeout defaults to 120s. Prefer read/write/edit/grep/glob when one fits; use shell for builds, tests, git, package managers, and other shell-only operations. Do not use multi-line here-strings (`@' ... '@`): the permission checker cannot read their body, so they always require approval — write the script to a file first and run it.";
    }
    return "Execute a shell command on the host (bash/sh). Output is truncated at 1MB, timeout defaults to 120s. Prefer read/write/edit/grep/glob when one fits; use shell for builds, tests, git, package managers, and other shell-only operations. Do not use here-documents (`<<`): the permission checker cannot read their body, so they always require approval — write the script to a file first and run it, or pass the program inline with `-c`.";
}

/** Construct the unified shell tool. cwd comes from context.env.cwd. */
export function createShellTool(opts?: {
    permissionBroker?: PermissionBroker;
    sessionId?: string;
}): ShellTool {
    return {
        name: "shell",
        label: "shell",
        description: getShellDescription(),
        parameters: shellSchema,
        executionMode: "sequential",
        taco: {
            promptSummary:
                "Run a host shell command. Output is truncated at 1MB, timeout defaults to 120s. Commands are checked against the permission broker — destructive or external commands prompt for approval unless the workspace has an allow rule. Prefer read/write/edit/grep/glob when one fits.",
            mutates: true,
        },
        async execute(
            toolCallId: string,
            params: ShellToolInput,
            _onUpdate: unknown,
            { env }: ExecutionToolContext,
            _invocation: unknown,
            piContext: Context,
        ): Promise<ShellToolResult> {
            // pi 0.85 carries cancellation on the Context rather than a
            // dedicated parameter.
            const signal = piContext.abortSignal;
            if (opts?.permissionBroker && opts.sessionId) {
                const decision = await opts.permissionBroker.evaluateAndRequest({
                    sessionId: opts.sessionId,
                    toolCallId,
                    command: params.command,
                    cwd: env.cwd,
                    signal,
                });
                if (!decision.approved) {
                    return deniedResult(decision.denialReason);
                }
            }
            const result =
                process.platform === "win32"
                    ? await runShell(
                          "powershell.exe",
                          ["-NoProfile", "-Command", withUtf8Output(params.command)],
                          {
                              cwd: env.cwd,
                              timeoutMs: params.timeout,
                              signal,
                          },
                      )
                    : await runShell(params.command, null, {
                          cwd: env.cwd,
                          timeoutMs: params.timeout,
                          signal,
                      });
            return {
                content: result.content,
                details: result.details,
                isError: result.isError,
            };
        },
    };
}
