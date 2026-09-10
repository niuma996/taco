/**
 * shell tool — unified host shell execution.
 *
 * On non-Windows platforms it runs commands through the system shell (bash/sh).
 * On Windows it runs `powershell.exe -NoProfile -Command`. Non-zero exits are
 * returned, not thrown, so the model can decide how to respond.
 */

import type { Static } from "typebox";
import { Type } from "typebox";
import { createLogger } from "../lib/logger.ts";
import type { PermissionBroker } from "../permissions/permissionBroker.ts";
import type {
    AgentHarnessTool,
    Context,
    ExecutionToolContext,
    TextContent,
} from "../runtime/pi/types.ts";
import { DEFAULT_TIMEOUT_MS, runShell } from "./shell.ts";

export type ShellTool = AgentHarnessTool<ExecutionToolContext>;

const log = createLogger("shellTool");

const shellSchema = Type.Object({
    command: Type.String({ description: "The shell command to execute." }),
    timeout: Type.Optional(
        Type.Number({ description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}).` }),
    ),
    description: Type.Optional(Type.String({ description: "Short description for logging." })),
});

type ShellToolResult = {
    content: TextContent[];
    details: {
        exitCode: number;
        interrupted: boolean;
        reason?: "permission_denied" | "permission_timeout" | "permission_aborted";
    };
    isError: boolean;
};

/**
 * Build the denial result for a `CommandPermissionDecision`.
 *
 * The text widens "do not retry this command" to "do not attempt the same
 * outcome by another route": models otherwise read a denial as "use a different
 * string" and re-attempt it through a pipe or a sibling tool. A `user_denied`
 * routes the model to `askUser`; an `undefined` reason means the command was
 * blocked by policy before any UI (deny rule, read-only broker, IM channel),
 * where there is no user to ask — so that path explains and stops instead.
 */
function deniedResult(reason: "user_denied" | "timeout" | "aborted" | undefined): ShellToolResult {
    if (reason === "timeout") {
        return {
            content: [
                {
                    type: "text",
                    text: "[command denied] The permission request timed out before the user responded. Do not retry automatically; if you still need this command, call `askUser` to ask the user. Otherwise wait for a new instruction.",
                },
            ],
            details: { exitCode: -1, interrupted: false, reason: "permission_timeout" },
            isError: true,
        };
    }
    if (reason === "aborted") {
        return {
            content: [
                {
                    type: "text",
                    text: "[command cancelled] The command was not executed because the current turn was cancelled while waiting for permission. Do not retry automatically.",
                },
            ],
            details: { exitCode: -1, interrupted: false, reason: "permission_aborted" },
            isError: true,
        };
    }
    // No denialReason means the command never reached the UI — it was denied by
    // policy (a deny rule, a read-only broker, an IM channel policy). There is
    // no interactive user behind this denial, so do not route to `askUser`: a
    // read-only subagent has no such tool. Explain and stop instead.
    if (reason === undefined) {
        return {
            content: [
                {
                    type: "text",
                    text: "[command denied] This command was blocked by the workspace's permission policy, not by the user. Do not retry it, and do not attempt the same outcome by another route — a different command, a pipeline, or another tool that has the same effect is still blocked. Explain why it was blocked and stop; if it should be allowed, ask the user to change the policy.",
                },
            ],
            details: { exitCode: -1, interrupted: false, reason: "permission_denied" },
            isError: true,
        };
    }
    if (reason !== "user_denied") {
        // broker emitted a new reason this build doesn't know about — fall
        // through to "user denied" text but flag it so it's visible in logs.
        log.warn("unrecognised permission denial reason", { reason: String(reason) });
    }
    return {
        content: [
            {
                type: "text",
                text: "[command denied] The user denied this command. Do not retry it, and do not attempt the same outcome by another route — a different command, a pipeline, or another tool (`write`/`edit`) that has the same effect is still the denied action. The denial is about the intent, not the exact string. If you still need that outcome, stop and call `askUser` to ask how the user wants to proceed; otherwise wait for a new instruction.",
            },
        ],
        details: { exitCode: -1, interrupted: false, reason: "permission_denied" },
        isError: true,
    };
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
        return "Execute a PowerShell command on Windows. Output is truncated at 1MB, timeout defaults to 120s. Prefer read/write/edit/grep/glob when one fits; use shell for builds, tests, git, package managers, and other shell-only operations.";
    }
    return "Execute a shell command on the host (bash/sh). Output is truncated at 1MB, timeout defaults to 120s. Prefer read/write/edit/grep/glob when one fits; use shell for builds, tests, git, package managers, and other shell-only operations.";
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
