/**
 * Per-turn toolset convergence for `AttachedSession.prompt()`.
 *
 * Split out of `AttachedSession.create()` because the merged-toolset rule is the
 * subtle part of the session: taking the workspace's set as the new collection
 * would delete the tools the session layer installed, while taking it as the
 * allowlist would hide them.
 */

import type { TacoTool } from "../../tools/index.ts";
import { orderTools, toolNamesKey } from "../../tools/toolOrder.ts";
import type { SessionToolState } from "./sessionToolState.ts";

export interface ToolsetRefreshArgs {
    readonly toolState: SessionToolState;
    /** Workspace-supplied re-assembly for this session, with the prompt built from it. */
    readonly refresh: () => { tools: TacoTool[]; systemPrompt: string };
    /** Write the rebuilt prompt into the cell the harness's systemPrompt thunk reads. */
    readonly setSystemPrompt: (prompt: string) => void;
}

/**
 * Build the per-turn refresher. Prompt and tools move together here — the
 * harness reads the prompt through a thunk, so a rebuild has to reach both or
 * the turn offers a tool the prompt denies.
 *
 * The change baseline is this session's own: the workspace-level set is shared
 * by every session, so whichever refreshed first would leave the rest seeing no
 * change. It is seeded by one assembly at construction — the attach-time tools
 * also carry session-bound ones (agent, skill) the refresh never returns — and
 * advances only once a commit lands, so a failed one is retried next turn.
 */
export function createToolsetRefresher(args: ToolsetRefreshArgs): () => Promise<void> {
    const { toolState, refresh, setSystemPrompt } = args;
    let baseline: readonly TacoTool[] = refresh().tools;
    return async () => {
        const next = refresh();
        if (toolNamesKey(next.tools) === toolNamesKey(baseline)) {
            return; // steady state — no writes, the prompt (cache prefix) untouched
        }
        const nextNames = new Set(next.tools.map((t) => t.name));
        const retired = new Set(baseline.map((t) => t.name).filter((name) => !nextNames.has(name)));
        await toolState.update((current) => {
            // `next.tools` is only the workspace-level set. Taking it as the
            // new collection would delete the tools this layer installed
            // (agent / skill / addTools / restored / always candidates) while
            // the allowlist still named them — which pi rejects as
            // `configured_tools_unavailable`; taking it as the new allowlist
            // would hide those same tools instead. So drop only what the
            // workspace retired and leave the rest alone.
            const kept = current.tools.filter(
                (t) => !retired.has(t.name) && !nextNames.has(t.name),
            );
            const tools = orderTools([...next.tools, ...kept]);
            const activeNames = current.activeNames.filter((name) => !retired.has(name));
            // pi gates visibility on the lane allowlist, so a tool that is
            // merely defined stays invisible; realign it to the new set.
            for (const { name } of tools) {
                if (!activeNames.includes(name)) activeNames.push(name);
            }
            return { tools, activeNames };
        });
        setSystemPrompt(next.systemPrompt);
        baseline = next.tools;
    };
}

/**
 * Add the workspace tools a persisted allowlist is missing.
 *
 * The allowlist is written when the session first runs and survives restarts,
 * while the workspace set is rebuilt from current config on every start. Once
 * the two drift (an IM policy flipped from deny to allow), the per-turn
 * refresher cannot see it: its baseline is seeded from the current config, so
 * it already matches — the prompt then offers `read` while pi rejects the call as
 * unavailable.
 *
 * Add-only on purpose: a persisted name with no definition may be a tool whose
 * load failed this time (an MCP server that is down), and dropping it would
 * lose the tool for good. Returns whether the allowlist changed; an equal list
 * is left untouched so the steady state stays byte-identical.
 */
export function alignActiveTools(
    toolState: SessionToolState,
    workspaceToolNames: readonly string[],
): Promise<boolean> {
    return toolState.update(({ tools, activeNames }) => {
        const defined = new Set(tools.map((t) => t.name));
        const missing = workspaceToolNames.filter(
            (name) => defined.has(name) && !activeNames.includes(name),
        );
        return missing.length === 0 ? undefined : { activeNames: [...activeNames, ...missing] };
    });
}
