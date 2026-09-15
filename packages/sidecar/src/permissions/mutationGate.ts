/**
 * Dispatch-level gate for mutating tool calls.
 *
 * Three guarantees that a system prompt cannot provide, because the model is
 * free to ignore prose:
 *   1. Plan mode is read-only. Only the plan document may be written.
 *   2. `write` / `edit` targets stay inside the workspace root.
 *   3. Absolute path arguments of unknown tools (MCP servers, extensions) stay
 *      inside the workspace root — the tool may do anything with them, but a
 *      target that escapes the root (including via a symlinked ancestor) is
 *      refused at dispatch.
 *
 * Registered as a `tool_call` hook. pi 0.85's `before_tool` short-circuits on
 * the first `block`, so an extension cannot overwrite a refusal decided here;
 * the gate stays registered after extension interceptors so arg rewrites are
 * visible to it.
 */

import { isAbsolute } from "node:path";
import type { PlanModeState } from "../plan/planModeState.ts";
import { getPlansDir } from "../plan/planPersistence.ts";
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
 */
const FS_MUTATING_TOOLS = new Set(["write", "edit"]);
const SHELL_TOOL = "shell";

/**
 * Top-level input keys that conventionally hold a filesystem path. Only these
 * are examined on unknown tools — a heuristic, since an MCP tool's schema is
 * opaque to the gate.
 *
 * Deliberately narrow, and it does NOT close every escape path: nested values
 * (`options.path`), array values (`paths: [...]`) and other key spellings
 * (`dir`, `output_path`, `src`) are unchecked.
 */
const PATH_LIKE_KEYS = ["path", "file_path", "filepath", "filename", "file", "target"] as const;

function pathArg(input: Record<string, unknown>): string | undefined {
    const value = input.path;
    return typeof value === "string" ? value : undefined;
}

export interface MutationGateOptions {
    /** Workspace root; every `write` / `edit` target must resolve inside it. */
    readonly root: string;
    readonly getPlanState: () => PlanModeState;
    /**
     * True when the tool is a built-in declaring `taco.mutates === false`.
     * Exempts `read` / `grep` / `glob` from the unknown-tool path fence —
     * they legitimately accept absolute paths outside the root. Production
     * wiring resolves this from the live harness toolset (MCP and extension
     * tools carry no `taco` metadata, so they are fenced); absent, every
     * non-builtin-mutating tool is treated as unknown — the fail-closed
     * default.
     */
    readonly isKnownReadOnly?: (toolName: string) => boolean | Promise<boolean>;
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

        if (FS_MUTATING_TOOLS.has(event.toolName)) {
            const raw = pathArg(event.input);
            if (raw === undefined) {
                return {
                    block: true,
                    reason: `${event.toolName} requires a string "path" argument`,
                };
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
        }

        // Unknown tools (MCP servers, extensions): fence ABSOLUTE path
        // arguments only. Whatever the tool does with the value, an absolute
        // target outside the workspace root — including via a symlinked
        // ancestor — is refused at dispatch.
        //
        // Relative values are deliberately NOT fenced. The gate does not know
        // what directory an unknown tool resolves them against (an MCP server
        // has its own spawn cwd, not ours), so `resolve(root, value)` would be
        // a guess: it refuses legitimate non-path arguments that merely look
        // relative (a branch name, an API path fragment like
        // `../v2/endpoint`) while proving nothing about where the tool would
        // actually write. An absolute path has no such ambiguity. Relative
        // escapes are left to the tool's own sandbox by design.
        if (await opts.isKnownReadOnly?.(event.toolName)) return undefined;

        for (const key of PATH_LIKE_KEYS) {
            const value = event.input[key];
            // `isAbsolute` also rejects URL-shaped values ("file:///etc/passwd",
            // "https://…"), so they need no separate carve-out.
            if (typeof value !== "string" || !isAbsolute(value)) continue;
            const resolved = await resolveWithinRoot(opts.root, value);
            if (!resolved.ok) {
                return {
                    block: true,
                    reason: `${event.toolName} argument "${key}" is an absolute path outside the workspace root (${opts.root}): ${value}. Refused by the unknown-tool path fence — if this argument is not a filesystem path, report the tool and key so the fence can be narrowed.`,
                };
            }
        }
        return undefined;
    };
}
