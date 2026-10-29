/**
 * Per-turn toolset convergence for `AttachedSession.prompt()`.
 *
 * Split out of `AttachedSession.create()` because the merged-toolset rule is the
 * subtle part of the session: taking the workspace's set as the new collection
 * would delete the tools the session layer installed, while taking it as the
 * allowlist would hide them.
 */

import { harnessContext } from "../../lib/harnessContext.ts";
import type { TacoToolContext } from "../../tools/context.ts";
import type { TacoTool } from "../../tools/index.ts";
import { orderTools } from "../../tools/toolOrder.ts";
import type { AgentHarness, AgentLane } from "../pi/types.ts";

export interface ToolsetRefreshArgs {
    readonly harness: AgentHarness<TacoToolContext>;
    readonly lane: AgentLane;
    /** Workspace-supplied re-assembly; undefined result means "unchanged". */
    readonly refresh: () =>
        | { tools: TacoTool[]; removed: string[]; systemPrompt: string }
        | undefined;
    /** Write the rebuilt prompt into the cell the harness's systemPrompt thunk reads. */
    readonly setSystemPrompt: (prompt: string) => void;
}

/**
 * Build the per-turn refresher. Prompt and tools move together here — the
 * harness reads the prompt through a thunk, so a rebuild has to reach both or
 * the turn offers a tool the prompt denies.
 */
export function createToolsetRefresher(args: ToolsetRefreshArgs): () => Promise<void> {
    const { harness, lane, refresh, setSystemPrompt } = args;
    return async () => {
        const next = refresh();
        if (!next) return; // unchanged — the steady state, no writes
        const retired = new Set(next.removed);
        const nextNames = new Set(next.tools.map((t) => t.name));
        // `next.tools` is only the workspace-level set. Taking it as the
        // new collection would delete the tools this layer installed
        // (agent / skill / addTools / restored / always candidates) while
        // the allowlist still named them — which pi rejects as
        // `configured_tools_unavailable`; taking it as the new allowlist
        // would hide those same tools instead. So drop only what the
        // workspace retired and leave the rest alone.
        const current = await harness.getTools(harnessContext);
        const kept = current.filter((t) => !retired.has(t.name) && !nextNames.has(t.name));
        const merged = orderTools([...next.tools, ...kept]);
        const active = (await lane.getActiveTools(harnessContext)).filter(
            (name) => !retired.has(name),
        );
        for (const name of merged.map((t) => t.name)) {
            if (!active.includes(name)) active.push(name);
        }
        setSystemPrompt(next.systemPrompt);
        await harness.setTools(merged, harnessContext);
        // pi gates visibility on the lane allowlist, so a tool that is
        // merely defined stays invisible; realign it to the new set.
        await lane.setActiveTools(active, harnessContext);
    };
}

export interface AlignActiveToolsArgs {
    readonly harness: AgentHarness<TacoToolContext>;
    readonly lane: AgentLane;
    /** Names the workspace offers this session right now. */
    readonly workspaceToolNames: readonly string[];
}

/**
 * Add the workspace tools a persisted allowlist is missing.
 *
 * The allowlist is written when the session first runs and survives restarts,
 * while the workspace set is rebuilt from current config on every start. Once
 * the two drift (an IM policy flipped from deny to allow), the per-turn
 * refresher cannot see it: it compares the workspace set against the previous
 * one *in this process*, finds them equal, and writes nothing — the prompt
 * then offers `read` while pi rejects the call as unavailable.
 *
 * Add-only on purpose: a persisted name with no definition may be a tool whose
 * load failed this time (an MCP server that is down), and dropping it would
 * lose the tool for good. Returns whether the allowlist changed; an equal list
 * is left untouched so the steady state stays byte-identical.
 */
export async function alignActiveTools(args: AlignActiveToolsArgs): Promise<boolean> {
    const { harness, lane, workspaceToolNames } = args;
    const defined = new Set((await harness.getTools(harnessContext)).map((t) => t.name));
    const active = await lane.getActiveTools(harnessContext);
    const missing = workspaceToolNames.filter(
        (name) => defined.has(name) && !active.includes(name),
    );
    if (missing.length === 0) return false;
    await lane.setActiveTools([...active, ...missing], harnessContext);
    return true;
}
