/**
 * Dispatch-level gate for mutating tool calls.
 *
 * Two guarantees that a system prompt cannot provide, because the model is free
 * to ignore prose:
 *   1. Plan mode is read-only. Only the plan document may be written.
 *   2. `write` / `edit` targets stay inside the workspace root.
 *
 * Registered as a `tool_call` hook. `emitHook` is last-writer-wins, so this
 * must be registered after extension interceptors — otherwise an extension
 * returning any non-undefined result would discard a `block` decided here.
 */

import type { PlanModeState } from "../tools/planModeState.ts";
import { getPlansDir } from "../tools/planPersistence.ts";
import { evaluateCommand } from "./commandPolicy.ts";
import { resolveWithinRoot } from "./workspaceBoundary.ts";

export interface ToolCallGateEvent {
    readonly toolName: string;
    readonly input: Record<string, unknown>;
}

export interface ToolCallGateResult {
    readonly block?: boolean;
    readonly reason?: string;
}

/**
 * Built-in tools that can change the filesystem. `read` / `grep` / `glob` /
 * `askUser` and the task / plan bookkeeping tools are absent by design.
 *
 * Extension-contributed tools are not classified here: the gate cannot know
 * whether a third-party tool mutates, so plan mode does not currently restrain
 * them.
 */
const FS_MUTATING_TOOLS = new Set(["write", "edit"]);
const SHELL_TOOL = "shell";

function pathArg(input: Record<string, unknown>): string | undefined {
    const value = input.path;
    return typeof value === "string" ? value : undefined;
}

export interface MutationGateOptions {
    /** Workspace root; every `write` / `edit` target must resolve inside it. */
    readonly root: string;
    readonly getPlanState: () => PlanModeState;
    /**
     * Snapshot the pre-write content of an allowed target. Invoked only after
     * containment and plan mode have passed, so a refused call never produces a
     * checkpoint. A snapshot failure does not block the write — it is reported
     * through `onSnapshotFailure` instead, because losing the ability to undo is
     * less harmful than refusing work the user asked for.
     */
    readonly captureBeforeWrite?: (absolutePath: string) => Promise<{
        ok: boolean;
        reason?: string;
    }>;
    readonly onSnapshotFailure?: (path: string, reason: string) => void;
}

export function createMutationGateHook(
    opts: MutationGateOptions,
): (event: ToolCallGateEvent) => Promise<ToolCallGateResult | undefined> {
    const plansDir = getPlansDir(opts.root);

    return async (event) => {
        const planActive = opts.getPlanState().active;

        if (event.toolName === SHELL_TOOL) {
            if (!planActive) return undefined;
            const command = typeof event.input.command === "string" ? event.input.command : "";
            // `mode: "auto"` and `rules: []` deliberately bypass any user-
            // configured shell allowlist: in plan mode we want every mutating
            // command refused regardless of how the user has tuned their
            // shell rules. The classifier still recognises built-in read-only
            // commands (`git log`, `ls`, ...), so inspection stays available.
            const readOnly = evaluateCommand(command, { mode: "auto", rules: [] });
            if (readOnly.behavior === "allow") return undefined;
            return {
                block: true,
                reason: `plan mode is read-only: shell command refused (${readOnly.reason}). Call planExit and get approval before running it.`,
            };
        }

        if (!FS_MUTATING_TOOLS.has(event.toolName)) return undefined;

        const raw = pathArg(event.input);
        if (raw === undefined) {
            return { block: true, reason: `${event.toolName} requires a string "path" argument` };
        }

        const resolved = await resolveWithinRoot(opts.root, raw);
        if (!resolved.ok) {
            return { block: true, reason: resolved.reason };
        }

        if (planActive) {
            const withinPlans = await resolveWithinRoot(plansDir, resolved.absolutePath);
            if (!withinPlans.ok) {
                return {
                    block: true,
                    reason: `plan mode is read-only: refused ${event.toolName} on ${raw}. Only the plan document under ${plansDir} may be written; call planExit to get approval first.`,
                };
            }
        }

        // Allowed from here on, so this is the last point at which the file's
        // pre-write content still exists.
        if (opts.captureBeforeWrite) {
            const snapshot = await opts.captureBeforeWrite(resolved.absolutePath);
            if (!snapshot.ok) {
                opts.onSnapshotFailure?.(resolved.absolutePath, snapshot.reason ?? "unknown");
            }
        }

        return undefined;
    };
}
