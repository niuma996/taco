/**
 * `instructions` tag — context hook.
 *
 * Resolves the workspace's CLAUDE.md / AGENTS.md / DESIGN.md against the
 * configured priority chain, wraps each found file as an independent
 * `<instructions source="…">…</instructions>` block, and appends them when
 * they are missing from the window (or the on-disk content has changed).
 *
 * Configuration is **lazy**: `getConfig()` is called on every hook invocation
 * so a `settings.write` patch to `taco.json: instructions` takes effect on the
 * next turn without restarting the sidecar. Compaction drops the tag, so the
 * next call after a compact re-injects. Unchanged content already in the
 * window is not re-appended — that used to be `throttleByContent`, whose skip
 * deleted `messages[0]` and busted the prompt-cache prefix.
 *
 * Subagent inheritance is handled separately at the system-prompt level by
 * `WorkspaceRuntime` / `AgentSpawner` — this hook only fires in the parent
 * session's context window.
 */

import type { InstructionsConfig } from "@taco-ai/protocol";
import {
    type InstructionsResolution,
    renderInstructionBlock,
    resolveInstructions,
} from "../config/instructions.ts";
import type { ContextEvent, ContextResult } from "../extensions/types.ts";
import { createLogger } from "../lib/logger.ts";
import type { AgentMessage } from "../runtime/pi/types.ts";
import { appendUserTag } from "./appendUserTag.ts";
import { findBalancedTagsSkippingFences } from "./fenceAware.ts";

const log = createLogger("tags/instructionsContext");

export interface BuildInstructionsContextHookOptions {
    /** Workspace cwd. The priority chain is rooted here. */
    cwd: string;
    /** Lazy config accessor — invoked on each hook call so hot-reload works. */
    getConfig: () => InstructionsConfig | undefined;
}

/**
 * Build a `context` hook that appends the `<instructions>` blocks when they
 * are missing from the window or the on-disk content has changed. Compaction
 * drops the tag (`compression.kind === "drop"`), so the next call after a
 * compact re-injects. Returns `undefined` when there is nothing new to add.
 *
 * Synchronous on purpose — `resolveInstructions` is a pure disk-read helper
 * with no awaits. Keeping this hook sync lets the `contextHookStack`
 * regression test (which exercises the
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
        const existing = collectExistingInstructionKeys(event.messages);
        let appended = false;
        for (const block of resolution.blocks) {
            const rendered = renderInstructionBlock(block);
            if (existing.has(instructionKey(block.source, block.content))) continue;
            appendUserTag(event.messages, rendered);
            appended = true;
        }
        return appended ? { messages: event.messages } : undefined;
    };
}

function instructionKey(source: string, body: string): string {
    return `${source}\u0000${body.trim()}`;
}

/** Keys of `<instructions>` blocks already in the window (source + trimmed body). */
function collectExistingInstructionKeys(messages: ReadonlyArray<AgentMessage>): Set<string> {
    const found = new Set<string>();
    for (const msg of messages) {
        const content = (msg as { content?: unknown }).content;
        const text =
            typeof content === "string"
                ? content
                : Array.isArray(content)
                  ? (content as Array<{ text?: string }>).map((b) => b.text ?? "").join("")
                  : "";
        if (!text.includes("<instructions")) continue;
        for (const match of findBalancedTagsSkippingFences(text, "instructions")) {
            found.add(instructionKey(match.attrs.source ?? "", match.inner));
        }
    }
    return found;
}

function logResolutionErrors(resolution: InstructionsResolution): void {
    for (const { name, message } of resolution.errors) {
        log.warn(`failed to read ${name}: ${message}`);
    }
}
