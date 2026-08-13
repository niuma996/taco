/**
 * shell tool — unified host shell execution.
 *
 * On non-Windows platforms it runs commands through the system shell (bash/sh).
 * On Windows it runs `powershell.exe -NoProfile -Command`. Non-zero exits are
 * returned, not thrown, so the model can decide how to respond.
 */

import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import { Type } from "typebox";
import { createLogger } from "../lib/logger.ts";
import type { PermissionBroker } from "../permissions/permissionBroker.ts";
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
 * Map a `CommandPermissionDecision.denialReason` to a `details.reason` value.
 * Keeping a `permission_` prefix avoids collision with other tools' reason
 * fields that may be merged into the same `details` payload downstream.
 *
 *   "user_denied" → "permission_denied"
 *   "timeout"     → "permission_timeout"
 *   "aborted"     → "permission_aborted"
 *   undefined     → "permission_denied" (denied by policy, never asked)
 */
function deniedResult(reason: "user_denied" | "timeout" | "aborted" | undefined): ShellToolResult {
    if (reason === "timeout") {
        return {
            content: [
                {
                    type: "text",
                    text: "[command denied] The command was not executed because the permission request timed out. Do not retry automatically; ask the user whether they want to run it again.",
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
    if (reason !== undefined && reason !== "user_denied") {
        // broker emitted a new reason this build doesn't know about — fall
        // through to "user denied" text but flag it so it's visible in logs.
        // `undefined` is not that case: the broker omits the field when a
        // command is denied by policy without ever reaching the UI (a `deny`
        // rule, or an `ask` degraded by a read-only broker).
        log.warn("unrecognised permission denial reason", { reason: String(reason) });
    }
    return {
        content: [
            {
                type: "text",
                text: "[command denied] The user explicitly denied execution of this command. Do not retry this command automatically unless the user gives a new instruction.",
            },
        ],
        details: { exitCode: -1, interrupted: false, reason: "permission_denied" },
        isError: true,
    };
}

export type ShellToolInput = Static<typeof shellSchema>;

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
            signal: AbortSignal | undefined,
            _onUpdate: unknown | undefined,
            { env }: ExecutionToolContext,
        ): Promise<ShellToolResult> {
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
                    ? await runShell("powershell.exe", ["-NoProfile", "-Command", params.command], {
                          cwd: env.cwd,
                          timeoutMs: params.timeout,
                          signal,
                      })
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
