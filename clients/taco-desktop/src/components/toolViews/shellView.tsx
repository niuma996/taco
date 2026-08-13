/**
 * shell tool view — bash and powershell share the same view.
 *
 * Input: `tool.args.command` (string); `tool.resultText` is the reducer's
 * `stringifyResult` output (see packages/sidecar/src/tools/shell.ts).
 * Terminal style: dark monospace background with a "$ <cmd>" header.
 */

import { truncate } from "./_util";
import { type ToolViewProps, toolViews } from "./registry";

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
    const prompt = tool.name === "powershell" ? "PS> " : "$ ";

    return (
        <>
            {command.length > 0 && (
                <div className="tool-card-shell-cmd" aria-label="command">
                    <span className="tool-card-shell-prompt" aria-hidden="true">
                        {prompt}
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

// Both bash and powershell point at the same view; the two registrations
// preserve the "tool name → view" 1:1 mapping semantics. Split them into
// independent components if/when powershell needs different behavior
// (e.g. a different prompt).
toolViews.bash = ShellToolView;
toolViews.powershell = ShellToolView;
