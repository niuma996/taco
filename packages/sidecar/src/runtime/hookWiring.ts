/**
 * hookWiring — hook assembly for `AgentHarness`, extracted from
 * `AttachedSession.create()`.
 *
 * Registration order matters — see the inline "HOOK ORDERING" comments.
 *
 * Returns unsubscribe + any handles the caller needs further. This module
 * owns no `AttachedSession` state, so hook assembly is independently
 * unit-testable.
 */

import type {
    AgentHarness,
    AgentHarnessEventResultMap,
    ContextEvent,
    ContextResult,
    ExecutionToolContext,
    Skill,
} from "@earendil-works/pi-agent-core";
import type { InstructionsConfig, SupportedLocale } from "@taco-ai/protocol";
import type { CheckpointManager } from "../checkpoints/manager.ts";
import { redactString } from "../extensions/builtin/outputRedaction/index.ts";
import type {
    ContextHookBuckets,
    ToolCallHook,
    ToolResultHookBuckets,
} from "../extensions/index.ts";
import { createLogger } from "../lib/logger.ts";
import type { MemoryStore } from "../memory/index.ts";
import { buildMemoryContextHook } from "../memory/memoryTag.ts";
import { createMutationGateHook } from "../permissions/mutationGate.ts";
import { buildSkillReinjector, type SkillReinjectorHandle } from "../skills/skillReinjector.ts";
import {
    buildCompactionReminderHook,
    buildDropPolicyContextHook,
    buildEnvContextHook,
    buildImChannelContextHook,
    buildInstructionsContextHook,
    buildPinAwareCompactHook,
    buildPlanModeContextHook,
    buildReplyLanguageContextHook,
    buildStripThinkingContextHook,
    type ImChannelContext,
} from "../tags/index.ts";
import { throttleByContent } from "../tags/throttle.ts";
import { type ActiveTasksState, buildActiveTasksContextHook } from "../tasks/activeTasksTag.ts";
import { buildTodoWriteReminderContextHook } from "../tasks/todoWriteReminder.ts";
import type { PinOnceConsumer } from "./pinOnceConsumer.ts";

const log = createLogger("taco-ext");

/**
 * An extension hook that hangs (an await that never settles) would block the
 * harness call chain forever — emitHook awaits each handler in order. Bound the
 * wait so a buggy hook degrades to `undefined` instead of wedging the session.
 * The hook's own work keeps running in the background (we can't cancel an
 * arbitrary async fn); only the wait is bounded. Cleared on settle so fast
 * hooks don't pile up timers.
 */
export const HOOK_TIMEOUT_MS = 2_000;

export function withHookTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            reject(new Error(`${label} hook timed out after ${HOOK_TIMEOUT_MS}ms`));
        }, HOOK_TIMEOUT_MS);
    });
    return Promise.race([promise, timeout]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

export interface HookWiringOptions {
    /** Workspace cwd — used by the instructions (CLAUDE.md) hook. */
    cwd: string;
    /** Thunk that reads the current UI locale live (supplied by AttachedSession). */
    getUiLocale?: () => SupportedLocale | undefined;
    /**
     * Lazy accessor for the current IM channel identity (platform type +
     * configured instance id). `undefined` for non-IM workspaces — the hook
     * injects nothing. Invoked on every LLM call so a settings.write that
     * reconfigures a channel is reflected on the next turn.
     */
    getImChannelContext?: () => ImChannelContext | undefined;
    /** Extension context hooks (builtins + external); undefined treated as empty. */
    extensionContextHooks?: ContextHookBuckets;
    /** Extension tool_call interceptors; undefined treated as empty. */
    extensionToolCallHooks?: ToolCallHook[];
    /** Extension tool_result interceptors (builtins + external); undefined treated as empty. */
    extensionToolResultHooks?: ToolResultHookBuckets;
    /** Loaded Skill[] — used by the reinjector hook in SkillTool. */
    skills?: readonly Skill[];
    /**
     * Thunk that reads the current compaction threshold live (supplied by
     * AttachedSession, same source as `effectiveCompaction`). The pin-aware
     * compact hook uses it to recompute `keepRecentTokens` as
     * `contextWindow × threshold × 0.5`, fixing pi's hard-coded 20000 which
     * makes low-threshold compactions ineffective. Falls back to 0.7.
     */
    getCompactionThreshold?: () => number;
    /**
     * Thunk returning the current `InstructionsConfig` (resolved from
     * `taco.json` / CLI). Lazy so a `settings.write` patch takes effect on
     * the next LLM call without a sidecar restart. Falls back to "all
     * default-enabled" when unset (the documented behavior for callers
     * that don't yet pass it through).
     */
    getInstructionsConfig?: () => InstructionsConfig | undefined;
    /** User-level memory store — injects `<memory>` tag on every context build. */
    memoryStore?: MemoryStore;
    /** Thunk returning the current session's task / plan state, used by the active_tasks hook. */
    getActiveTasksState?: () => ActiveTasksState;
    /**
     * Workspace root for the mutation gate. When set, `write` / `edit` targets
     * must resolve inside it, and plan mode blocks mutating calls at dispatch
     * rather than relying on the injected directive.
     */
    mutationGateRoot?: string;
    /**
     * Turn-scoped pre-write snapshots. When present, the mutation gate captures
     * each allowed `write` / `edit` target before it changes, so a turn's edits
     * can be rolled back. Absent → no snapshots (the gate still enforces
     * containment and plan mode).
     */
    checkpointManager?: CheckpointManager;
    /**
     * PinOnceConsumer instance — drives skip logic for the `memory` pinOnce tag.
     * When provided, the memory context hook checks `consumer.isConsumed(instanceId)`
     * before injecting and skips already-consumed instances. CompactionController
     * also subscribes to session_compact events so the consumed set grows as
     * compressions complete.
     */
    pinOnceConsumer?: PinOnceConsumer;
}

type ContextHookResult = AgentHarnessEventResultMap["context"];

/**
 * Wraps a user-supplied context hook so a throwing / rejecting extension
 * cannot fail the LLM call. Returns undefined on any error. The wrapper MUST
 * be async + await to catch both sync throws AND rejected promises — a
 * sync-only try/catch lets async rejections escape and fail the call.
 *
 * Built-in protocol hooks are NOT wrapped (they are trusted). Only
 * extension-supplied hooks flow through this guard.
 */
function wrapContextHook(
    hook: (event: ContextEvent) => ContextResult | undefined | Promise<ContextResult | undefined>,
    label: string,
): (event: ContextEvent) => Promise<ContextHookResult> {
    return async (event) => {
        try {
            return await withHookTimeout(Promise.resolve(hook(event)), label);
        } catch (e) {
            log.error(`${label} context hook failed:`, e);
            return undefined;
        }
    };
}

/**
 * Wrap an extension-supplied hook (tool_call / tool_result) so sync throws
 * AND async rejections are caught and logged, never failing the harness call.
 * Also bounds the wait — a hung hook times out instead of blocking the harness
 * chain. Same pattern as wrapContextHook above.
 *
 * `onFailure` supplies the fallback result. It defaults to `undefined`
 * ("no opinion"), which is right for tool_result but NOT for tool_call, where
 * `undefined` means "allow": a hook whose whole job is to block a dangerous
 * command must not fail open just because it was slow. See the tool_call
 * registration below, which passes a fail-closed fallback.
 */
export function wrapHook<T, R>(
    fn: (e: T) => R | Promise<R>,
    label: string,
    onFailure?: (err: unknown) => R | undefined,
): (e: T) => Promise<R | undefined> {
    return async (e) => {
        try {
            return await withHookTimeout(Promise.resolve(fn(e)), label);
        } catch (err) {
            log.error(`${label} hook failed:`, err);
            return onFailure?.(err);
        }
    };
}

/**
 * Registers every hook (protocol + extension + debug) on the harness and
 * returns unsubscribe + any handles the caller needs further (e.g. the
 * skill reinjector handle, written to by SkillTool).
 *
 * - protocol context hooks first (trusted, not wrapped)
 * - extension context / tool_call / tool_result hooks next (wrapped, errors → undefined)
 * - debug hook gated by TACO_DEBUG_LLM_PAYLOAD=1, off by default
 */
export interface WireHarnessResult {
    /** Unsubscribe all hooks — call on session dispose. */
    unsubscribe: () => void;
    /** Handle to push state into the skill reinjector (undefined if no skills registered). */
    skillReinjector?: SkillReinjectorHandle;
}

export async function wireHarnessHooks(
    harness: AgentHarness<ExecutionToolContext>,
    opts: HookWiringOptions,
): Promise<WireHarnessResult> {
    const disposers: Array<() => void> = [];
    let skillReinjector: SkillReinjectorHandle | undefined;

    // ── protocol context hooks (trusted, not wrapped) ──
    // 1. strip `drop` policy tags before LLM conversion
    disposers.push(harness.on("context", buildDropPolicyContextHook()));
    // 2. prepend `<instructions>` (CLAUDE.md), throttled so unchanged content
    //    is only re-injected every 20 turns at most. After compaction the old
    //    copy is gone (instructions is a `drop` tag), so the skip cap ensures
    //    the model periodically re-receives CLAUDE.md.
    disposers.push(
        harness.on(
            "context",
            throttleByContent(
                buildInstructionsContextHook({
                    cwd: opts.cwd,
                    // Fall back to "no config" (= defaults) when the caller did
                    // not supply a thunk — preserves the documented behavior
                    // for tests / older call sites that don't pass it through.
                    getConfig: opts.getInstructionsConfig ?? (() => undefined),
                }),
                { maxConsecutiveSkips: 20 },
            ),
        ),
    );
    // 3. append `<env>` (current local time) to every LLM context.
    disposers.push(harness.on("context", buildEnvContextHook()));
    // 3b. append `<im_channel>` (channel type + id) for IM sessions only. The
    //     getter yields undefined for non-IM workspaces so this is a no-op there.
    if (opts.getImChannelContext) {
        disposers.push(harness.on("context", buildImChannelContextHook(opts.getImChannelContext)));
    }
    // 4. prepend `<reply_language>` whenever getUiLocale() returns a value —
    //    content is stable across turns unless the user switches UI language
    //    (rare), so wrap in throttleByContent to skip redundant re-injection.
    if (opts.getUiLocale) {
        disposers.push(
            harness.on(
                "context",
                throttleByContent(buildReplyLanguageContextHook(opts.getUiLocale), {
                    maxConsecutiveSkips: 50,
                }),
            ),
        );
    }
    // 5. strip signature-bearing ThinkingContent blocks when thinkingLevel === "off",
    //    preventing Anthropic from triggering signature replay with
    //    thinking={type:"disabled"}. The thunk reads harness state live so
    //    `setThinkingLevel` takes effect on the next LLM call; session storage
    //    is untouched and history remains visible.
    disposers.push(
        harness.on(
            "context",
            buildStripThinkingContextHook(() => harness.getThinkingLevel()),
        ),
    );
    // 6. plan mode directive: while plan mode is active, inject a read-only
    //    planning prompt that guides the model to use the explorer subagent.
    const getActiveTasksState = opts.getActiveTasksState;
    if (getActiveTasksState) {
        disposers.push(
            harness.on(
                "context",
                buildPlanModeContextHook(() => getActiveTasksState().planState),
            ),
        );
    }
    // 7. skill body reinjection: drain pending queue + restore compacted-away skill bodies
    if (opts.skills && opts.skills.length > 0) {
        const { hook, handle } = buildSkillReinjector({ skills: opts.skills });
        disposers.push(harness.on("context", hook));
        skillReinjector = handle;
    }

    // ── session_before_compact hook (trusted, not wrapped) ──
    // 7. pin-aware compression: extractAndStripPinned + directive + pi's
    //    default compact() + extended file ops + structured facts + verbatim
    //    pin tail appended to summary. Throws fall back to the harness's
    //    default compaction path (never blocks the call).
    //    On success, arms the per-session compaction reminder (single
    //    `<compaction_reminder>` next context build). The reminder handle is
    //    created per wireHarnessHooks call so its flag is isolated to this
    //    harness — module-level state would leak across the many sessions
    //    a single sidecar multiplexes.
    const compactionReminder = buildCompactionReminderHook();
    const pinAwareCompact = buildPinAwareCompactHook({
        models: harness.models,
        getModel: () => harness.getModel(),
        getThreshold: opts.getCompactionThreshold ?? (() => 0.7),
    });
    disposers.push(
        harness.on("session_before_compact", async (event) => {
            const result = await pinAwareCompact(event);
            if (result?.compaction) compactionReminder.notify();
            return result;
        }),
    );

    // ── memory context hook — injects <memory> tag; skips if already consumed.
    // Runs after protocol hooks so memory is the outermost user-context layer.
    // Throttled — MEMORY.md content is stable for long stretches, so don't
    // repeat the same user message verbatim each turn. Throttle hashes the
    // resulting messages and skips when content is unchanged.
    if (opts.memoryStore) {
        disposers.push(
            harness.on(
                "context",
                throttleByContent(buildMemoryContextHook(opts.memoryStore, opts.pinOnceConsumer)),
            ),
        );
    }

    // ── task-driven context hooks (both gated on getActiveTasksState) ──
    //  - active_tasks: continuation guidance for unfinished tasks
    //  - todo_reminder: nags when TodoWrite unused 10+ assistant turns
    if (opts.getActiveTasksState) {
        const getState = opts.getActiveTasksState;
        disposers.push(harness.on("context", buildActiveTasksContextHook(getState)));
        disposers.push(
            harness.on(
                "context",
                buildTodoWriteReminderContextHook(() => getState().store),
            ),
        );
    }

    // ── safety-net context hook — always returns event.messages so emitHook's
    //    last-writer-wins semantics pick up all in-place mutations applied
    //    by preceding hooks. Without it, if every hook returns undefined
    //    the transformContext fallback reverts to the unmodified clone.
    disposers.push(harness.on("context", (event) => ({ messages: event.messages })));

    // ── extension context hooks (wrapped, errors → undefined) ──
    const extCtxHooks = opts.extensionContextHooks ?? { builtins: [], external: [] };
    const allExtCtxHooks = [
        ...extCtxHooks.builtins.map((h) => wrapContextHook(h, "ext-builtin")),
        ...extCtxHooks.external.map((h) => wrapContextHook(h, "ext-external")),
    ];
    for (const wrapped of allExtCtxHooks) {
        disposers.push(harness.on("context", wrapped));
    }

    // ── compaction_reminder context hook — fires once after each compaction.
    //    Registered LAST so it is the final non-undefined return value: any
    //    extension hook that returns a fresh `{ messages: [] }` (legal per
    //    last-writer-wins) cannot clobber the unshift we do here.
    disposers.push(harness.on("context", compactionReminder.hook));

    // ── extension tool_call / tool_result hooks (wrapped) ──
    // tool_call fails CLOSED: `undefined` means "allow", so a gatekeeper hook
    // that hangs or throws would silently permit the very call it exists to
    // block. Timing out into `{ block: true }` is the safe direction — the
    // tool call is refused with a reason instead of slipping through.
    for (const hook of opts.extensionToolCallHooks ?? []) {
        disposers.push(
            harness.on(
                "tool_call",
                wrapHook(hook, "tool_call", () => ({
                    block: true,
                    reason: "tool_call hook failed or timed out; blocking to fail closed",
                })),
            ),
        );
    }
    // ── mutation gate (trusted) ──
    // Registered AFTER the extension tool_call hooks on purpose: emitHook is
    // last-writer-wins, so a gate registered earlier could have its `block`
    // silently replaced by any extension that returns a non-undefined result.
    // Being last makes the containment / plan-mode refusal final.
    if (opts.mutationGateRoot && getActiveTasksState) {
        const checkpoints = opts.checkpointManager;
        const gate = createMutationGateHook({
            root: opts.mutationGateRoot,
            getPlanState: () => getActiveTasksState().planState,
            captureBeforeWrite: checkpoints
                ? (path) => checkpoints.captureBeforeWrite(path)
                : undefined,
            onSnapshotFailure: (path, reason) => {
                log.error(`checkpoint snapshot failed for ${path}: ${reason}`);
            },
        });
        disposers.push(
            harness.on(
                "tool_call",
                wrapHook(gate, "mutation-gate", () => ({
                    block: true,
                    reason: "mutation gate failed or timed out; blocking to fail closed",
                })),
            ),
        );
    }

    const extToolResultHooks = opts.extensionToolResultHooks ?? { builtins: [], external: [] };
    for (const hook of extToolResultHooks.builtins) {
        disposers.push(harness.on("tool_result", wrapHook(hook, "tool_result:builtin")));
    }
    for (const hook of extToolResultHooks.external) {
        disposers.push(harness.on("tool_result", wrapHook(hook, "tool_result:external")));
    }

    // ── debug hook (gated by TACO_DEBUG_LLM_PAYLOAD=1) ──
    // stderr → sidecar-log event → desktop Console / LLM Dump panel. Off by
    // default to avoid polluting production stderr.
    //
    // Single-line constraint: each stderr line MUST keep the `[taco:llm]`
    // prefix at column 0 — the desktop matches it with `startsWith` and the
    // logger's `<ts> [level] [scope]` format would break that. This is a
    // structured debug channel that borrows stderr, not a log: it writes
    // stderr directly and deliberately bypasses `lib/logger.ts`.
    // Tauri's `BufReader::lines()` splits on `\n`, so multi-line content
    // gets truncated and later lines lose the prefix and are dropped.
    // Fix: escape `\n` / `\r` to literal `\\n` / `\\r` before printing;
    // the desktop unescapes on display.
    //
    // Safety: even with debug on, logs must not leak raw API keys — reuse
    // `outputRedaction.redactString` to scrub before fold.
    if (process.env.TACO_DEBUG_LLM_PAYLOAD) {
        disposers.push(
            harness.on("before_provider_payload", (event) => {
                const payload = event.payload as {
                    system?: string | unknown[];
                    messages?: Array<{ role: string; content: string | unknown[] }>;
                };
                const fold = (s: string): string => s.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
                // `content` may be string or block array; normalize to one
                // line (cap raised so system prompt / long messages stay visible).
                const render = (c: string | unknown[]): string => {
                    const raw = typeof c === "string" ? c : JSON.stringify(c);
                    const capped = raw.length > 2000 ? `${raw.slice(0, 2000)}…` : raw;
                    // Scrub API keys / tokens BEFORE fold so [taco:llm] prefix
                    // is preserved and line breaks stay escaped. redactString
                    // returns the redacted text unchanged on miss (zero overhead
                    // when there's nothing to redact).
                    const [scrubbed] = redactString(capped);
                    return fold(scrubbed);
                };
                const dump = (s: string): void => {
                    process.stderr.write(`[taco:llm] ${s}\n`);
                };
                dump("=== payload to model ===");
                // `system` is a separate field in Anthropic, not a message —
                // print it on its own line.
                if (payload.system !== undefined) {
                    dump(`[system] ${render(payload.system)}`);
                }
                for (const [i, msg] of (payload.messages ?? []).entries()) {
                    dump(`[${i}] ${msg.role}: ${render(msg.content)}`);
                }
                return undefined;
            }),
        );
    }

    return {
        unsubscribe: () => {
            for (const off of disposers) off();
        },
        skillReinjector,
    };
}
