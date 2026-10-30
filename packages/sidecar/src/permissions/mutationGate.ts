/**
 * Dispatch-level gate for mutating tool calls.
 *
 * Three guarantees that a system prompt cannot provide, because the model is
 * free to ignore prose:
 *   1. Plan mode is read-only. Only the plan document may be written.
 *   2. Built-in write targets stay inside the workspace root, an associated
 *      directory, or an `extraWriteRoots` entry. Which argument names the
 *      target comes from `tools/fileAccess.ts` — PDF tools write `output` /
 *      `outputDir`, which the unknown-tool path fence does not see.
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

import { isAbsolute, resolve } from "node:path";
import type { PlanModeState } from "../plan/planModeState.ts";
import { getPlansDir } from "../plan/planPersistence.ts";
import { fileAccessOf, readPathsOf } from "../tools/fileAccess.ts";
import { evaluateReadOnlyCommand } from "./commandPolicy.ts";
import {
    expandHomeAndFileUrl,
    normalizeBuiltinToolPath,
    resolveWithinRoot,
    resolveWithinRootSet,
} from "./workspaceBoundary.ts";

export interface ToolCallGateEvent {
    readonly toolName: string;
    readonly input: Record<string, unknown>;
}

export interface ToolCallGateResult {
    readonly block?: boolean;
    readonly reason?: string;
}

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

export interface MutationGateOptions {
    /** Workspace root; every built-in write target must resolve inside it. */
    readonly root: string;
    /**
     * The workspace's associated directories, resolved on every call.
     *
     * They widen the set of directories the workspace may write to: a
     * built-in write target inside one of them is allowed, and a shell
     * command may `cd` into one. They do NOT merge another workspace's tool
     * configuration — MCP servers, tool sets and subagent toolsets stay
     * anchored to the workspace's own root — and they do not widen the
     * unknown-tool path fence.
     *
     * The set is read per call so a grant added or removed mid-session
     * reaches the next command.
     */
    readonly getAssociatedRoots?: () => readonly string[];
    readonly getPlanState: () => PlanModeState;
    /**
     * Additional directories a built-in write may target outside
     * `root`, checked with the same symlink-safe containment. Plan mode
     * ignores them (it still allows only the plan document), and the
     * unknown-tool path fence does not consult them: an MCP or extension tool
     * stays fenced to `root`.
     *
     * Production passes `$TACO_HOME/skills` and `$TACO_HOME/agents`, for
     * local main sessions only, so skill and agent authoring works without a
     * shell redirect that prompts. `$TACO_HOME` itself is deliberately not
     * included: `taco.json` holds API keys and the shell permission rules, and
     * a silent write there could disable every later approval.
     */
    readonly extraWriteRoots?: readonly string[];
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
     * The directories a read-only tool may reach, when set.
     *
     * `read` / `grep` / `glob` are exempt from the unknown-tool path fence
     * (they legitimately take absolute paths), so without this they can read
     * anywhere on the machine. An IM conversation is driven by a third party,
     * so its reads are fenced to the workspace's own directory plus the
     * directories the user associated with it.
     *
     * The primary is the workspace's execution directory; the associated
     * roots come from `getAssociatedRoots`. Unset (a local session) leaves
     * reads unfenced.
     */
    readonly readRoots?: {
        readonly primary: string;
        readonly getAssociated?: () => readonly string[];
        /**
         * Fixed extra roots that are readable but not writable and not
         * workspace directories, e.g. the session's attachment directory.
         */
        readonly extra?: readonly string[];
    };
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

/**
 * Refuse a read that lands outside the allowed roots.
 *
 * The allowed set is the workspace's execution directory plus the
 * directories the user associated with it. A read outside is refused
 * outright — the caller is told it has no access, and told not to try
 * again, because a third-party-driven conversation that keeps retrying
 * would otherwise turn a denial into a search loop.
 *
 * Returns undefined when the read is allowed (or when the tool takes no
 * path argument).
 */
async function fenceReadPath(
    event: ToolCallGateEvent,
    roots: {
        primary: string;
        getAssociated?: () => readonly string[];
        extra?: readonly string[];
    },
): Promise<ToolCallGateResult | undefined> {
    // An empty list means the call named no path; `grep` / `glob` then
    // search the cwd, which is inside the primary root.
    const paths = readPathsOf(event.toolName, event.input);
    if (!paths) return undefined;
    const associated = [...(roots.getAssociated?.() ?? []), ...(roots.extra ?? [])];
    for (const raw of paths) {
        const target = normalizeBuiltinToolPath(raw);
        const resolved = await resolveWithinRootSet(roots.primary, associated, target);
        if (resolved.ok) continue;
        return {
            block: true,
            reason: `${event.toolName} cannot read ${raw}: this session has no access outside its own directory. Do not retry it or look for another way to read the file — tell the user it is outside your access.`,
        };
    }
    return undefined;
}

/**
 * Resolve a built-in write target the way `write` / `edit` are resolved.
 *
 * Extra roots are ignored in plan mode, and a relative path is never
 * re-anchored onto one: pi resolves a relative path against cwd.
 */
async function containWrite(
    opts: MutationGateOptions,
    plansDir: string,
    planActive: boolean,
    toolName: string,
    raw: string,
): Promise<{ ok: true; absolutePath: string } | { ok: false; block: ToolCallGateResult }> {
    // Normalise first: pi expands `~/…`, strips a leading `@` and
    // decodes `file://…` before writing, so checking the raw string
    // let `~/.taco/taco.json` pass as if it were inside the root.
    const target = normalizeBuiltinToolPath(raw);
    let resolved = await resolveWithinRootSet(opts.root, opts.getAssociatedRoots?.() ?? [], target);
    if (!resolved.ok && !planActive && opts.extraWriteRoots?.length) {
        const absoluteTarget = resolve(opts.root, target);
        for (const extra of opts.extraWriteRoots) {
            const inExtra = await resolveWithinRoot(extra, absoluteTarget);
            if (inExtra.ok) {
                resolved = inExtra;
                break;
            }
        }
    }
    if (!resolved.ok) {
        return { ok: false, block: { block: true, reason: resolved.reason } };
    }
    if (planActive) {
        const withinPlans = await resolveWithinRoot(plansDir, resolved.absolutePath);
        if (!withinPlans.ok) {
            return {
                ok: false,
                block: {
                    block: true,
                    reason: `plan mode is read-only: refused ${toolName} on ${raw}. Only the plan document under ${plansDir} may be written; call planExit to get approval first.`,
                },
            };
        }
    }
    return { ok: true, absolutePath: resolved.absolutePath };
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
            //
            // The authorized directories include the workspace's associated
            // ones, so `cd <associated> && ls` stays inspectable in plan
            // mode — the same scope the command has outside plan mode.
            const readOnly = evaluateReadOnlyCommand(command, {
                cwd: opts.root,
                allowedRoots: [opts.root, ...(opts.getAssociatedRoots?.() ?? [])],
            });
            if (readOnly.behavior === "allow") return undefined;
            return {
                block: true,
                reason: `plan mode is read-only: shell command refused (${readOnly.reason}). Call planExit and get approval before running it.`,
            };
        }

        const writeKey = fileAccessOf(event.toolName)?.write;
        if (writeKey) {
            const raw = event.input[writeKey];
            if (typeof raw !== "string") {
                return {
                    block: true,
                    reason: `${event.toolName} requires a string "${writeKey}" argument`,
                };
            }
            const contained = await containWrite(opts, plansDir, planActive, event.toolName, raw);
            if (!contained.ok) return contained.block;

            // This branch returns, so a PDF tool's reads never reach the fence
            // below. Check them here, and only when reads are fenced at all.
            if (opts.readRoots) {
                const refusal = await fenceReadPath(event, opts.readRoots);
                if (refusal) return refusal;
            }

            // Allowed from here on, so this is the last point at which the file's
            // pre-write content still exists.
            if (opts.captureBeforeWrite) {
                const snapshot = await opts.captureBeforeWrite(contained.absolutePath);
                if (!snapshot.ok) {
                    opts.onSnapshotFailure?.(contained.absolutePath, snapshot.reason ?? "unknown");
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
        //
        // The read fence comes FIRST: a known-read-only tool is exempt from
        // the unknown-tool fence below, so a read that skipped this check
        // would reach anywhere on the machine.
        if (opts.readRoots) {
            const refusal = await fenceReadPath(event, opts.readRoots);
            if (refusal) return refusal;
        }

        if (await opts.isKnownReadOnly?.(event.toolName)) return undefined;

        for (const key of PATH_LIKE_KEYS) {
            const value = event.input[key];
            if (typeof value !== "string") continue;
            // `~/…` and `file://…` name an absolute location just as
            // unambiguously as `/…` does, so they are fenced too. Other
            // URL-shaped values ("https://…", "s3://…") stay non-absolute after
            // expansion and pass. A leading `@` is pi-specific and not stripped.
            const expanded = expandHomeAndFileUrl(value);
            if (!isAbsolute(expanded)) continue;
            const resolved = await resolveWithinRoot(opts.root, expanded);
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
