/**
 * shell tool view.
 *
 * Input: `tool.args.command` (string); `tool.resultText` is the reducer's
 * `stringifyResult` output (see packages/sidecar/src/tools/shell.ts).
 * Terminal style: dark monospace background with a "$ <cmd>" header.
 *
 * The prompt string is fixed: the sidecar runs one `shell` tool and chooses the
 * interpreter itself, so args carry no shell kind to branch on.
 */

import { truncate } from "./_util";
import { type ToolViewProps, type ToolViewSpec, toolViews } from "./registry";

/** Truncate the command string (default 200 chars) so the folded card still shows its semantics. */
function trimCmd(s: string, max = 200): string {
    return truncate(s, max);
}

/** Truncate the command result. While running, tighten further to 240 to reduce
 *  long streaming-output jitter. */
function trimResult(s: string, isRunning: boolean, max = 480): string {
    return truncate(s, isRunning ? 240 : max);
}

export function ShellToolView({ tool }: ToolViewProps) {
    const args = (tool.args ?? {}) as { command?: unknown };
    const command = typeof args.command === "string" ? args.command : "";
    const isRunning = tool.status === "running";

    return (
        <>
            {command.length > 0 && (
                <div className="tool-card-shell-cmd" aria-label="command">
                    <span className="tool-card-shell-prompt" aria-hidden="true">
                        ${" "}
                    </span>
                    <span className="tool-card-shell-cmd-text">{trimCmd(command)}</span>
                </div>
            )}
            {tool.resultText && (
                <pre className={`tool-card-shell-result ${isRunning ? "streaming" : ""}`}>
                    {trimResult(tool.resultText, isRunning)}
                </pre>
            )}
            {isRunning && !tool.resultText && <div className="tool-card-shell-empty">running…</div>}
        </>
    );
}

// The command already leads the body, so the head repeating it adds nothing.
// Registered as "shell" — the sidecar's tool name (createShellTool). The
// earlier "bash" / "powershell" keys never matched a real tool, so this view
// had never rendered and shell cards fell back to the default body.
export const shellSpec: ToolViewSpec = { summary: () => null, body: ShellToolView };

toolViews.shell = shellSpec;
