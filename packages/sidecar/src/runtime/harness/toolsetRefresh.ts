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
        const merged = [...next.tools, ...kept];
        const active = (await lane.getActiveTools(harnessContext)).filter(
            (name) => !retired.has(name),
        );
        for (const name of nextNames) {
            if (!active.includes(name)) active.push(name);
        }
        setSystemPrompt(next.systemPrompt);
        await harness.setTools(merged, harnessContext);
        // pi gates visibility on the lane allowlist, so a tool that is
        // merely defined stays invisible; realign it to the new set.
        await lane.setActiveTools(active, harnessContext);
    };
}
