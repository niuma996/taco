/**
 * `instructions` tag — context hook.
 *
 * Resolves the workspace's CLAUDE.md / AGENTS.md / DESIGN.md against the
 * configured priority chain, wraps each found file as an independent
 * `<instructions source="…">…</instructions>` block, and prepends them to
 * every LLM call's context window as the first user message.
 *
 * Configuration is **lazy**: `getConfig()` is called on every hook invocation
 * so a `settings.write` patch to `taco.json: instructions` takes effect on the
 * next turn without restarting the sidecar. The expensive work (disk reads)
 * still happens here — the outer `throttleByContent(maxConsecutiveSkips: 20)`
 * caches the merged hash so unchanged content is re-injected at most once per
 * 20 turns (per hookWiring.ts).
 *
 * Subagent inheritance is handled separately at the system-prompt level by
 * `WorkspaceRuntime` / `AgentSpawner` — this hook only fires in the parent
 * session's context window.
 */

import type { AgentMessage, ContextEvent, ContextResult } from "@earendil-works/pi-agent-core";
import type { InstructionsConfig } from "@taco-ai/protocol";
import {
    type InstructionBlock,
    type InstructionsResolution,
    renderInstructionBlock,
    resolveInstructions,
} from "../config/instructions.ts";
import { createLogger } from "../lib/logger.ts";
import { createUserMessage } from "./builder.ts";

const log = createLogger("tags/instructionsContext");

export interface BuildInstructionsContextHookOptions {
    /** Workspace cwd. The priority chain is rooted here. */
    cwd: string;
    /** Lazy config accessor — invoked on each hook call so hot-reload works. */
    getConfig: () => InstructionsConfig | undefined;
}

/**
 * Build a `context` hook that prepends the `<instructions>` blocks to every
 * LLM call's context window. Returns a no-op hook when nothing resolves (the
 * inner hook returns `undefined` and `throttleByContent` short-circuits).
 *
 * Synchronous on purpose — `resolveInstructions` is a pure disk-read helper
 * with no awaits, and the surrounding `throttleByContent` wrapper already
 * adapts to the harness's async `ContextEvent` signature. Keeping this hook
 * sync lets the `contextHookStack` regression test (which exercises the
 * emitHook last-writer-wins semantics with a synchronous `for` loop) see the
 * `event.messages` mutation immediately.
 */
export function buildInstructionsContextHook(
    opts: BuildInstructionsContextHookOptions,
): (event: ContextEvent) => ContextResult | undefined {
    const { cwd, getConfig } = opts;
    return (event: ContextEvent): ContextResult | undefined => {
        const resolution = resolveInstructions({ cwd, config: getConfig() });
        logResolutionErrors(resolution);
        if (!resolution.enabled || resolution.blocks.length === 0) {
            return undefined;
        }
        const wrapped = resolution.blocks.map(renderBlock);
        event.messages.unshift(...wrapped);
        return { messages: event.messages };
    };
}

function renderBlock(block: InstructionBlock): AgentMessage {
    return createUserMessage(renderInstructionBlock(block));
}

function logResolutionErrors(resolution: InstructionsResolution): void {
    for (const { name, message } of resolution.errors) {
        log.warn(`failed to read ${name}: ${message}`);
    }
}
