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

import type { InstructionsConfig, SupportedLocale } from "@taco-ai/protocol";
import type { CheckpointManager } from "../../checkpoints/manager.ts";
import { redactString } from "../../extensions/builtin/outputRedaction/index.ts";
import type {
    ContextEvent,
    ContextHookBuckets,
    ContextResult,
    ToolCallEvent,
    ToolCallHook,
    ToolCallResult,
    ToolResultEvent,
    ToolResultHookBuckets,
    ToolResultPatch,
} from "../../extensions/index.ts";
import { withDeadline } from "../../lib/async.ts";
import { harnessContext } from "../../lib/harnessContext.ts";
import { createLogger } from "../../lib/logger.ts";
import type { MemoryStore } from "../../memory/index.ts";
import { buildMemoryContextHook } from "../../memory/memoryTag.ts";
import { createMutationGateHook } from "../../permissions/mutationGate.ts";
import { buildSkillReinjector, type SkillReinjectorHandle } from "../../skills/skillReinjector.ts";
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
} from "../../tags/index.ts";
import { throttleByContent } from "../../tags/throttle.ts";
import { type ActiveTasksState, buildActiveTasksContextHook } from "../../tasks/activeTasksTag.ts";
import { buildTodoWriteReminderContextHook } from "../../tasks/todoWriteReminder.ts";
import type { PinOnceConsumer } from "../compaction/pinOnceConsumer.ts";
import type {
    AgentHarness,
    AgentLane,
    AgentMessage,
    AgentToolResult,
    ExecutionToolContext,
    JsonValue,
    Models,
    Skill,
    ThinkingLevel,
} from "../pi/types.ts";

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

/**
 * Thin wrapper over `withDeadline` for extension hooks. Keeps the original
 * `(promise, label)` signature so existing call sites and tests do not
 * change; the underlying timer / signal / cleanup logic now lives in one
 * place (`lib/async.withDeadline`) and is shared with MCP, shell, and
 * future capability callers.
 *
 * The trailing " hook" on the label preserves the original error message
 * (`"foo hook timed out after 2000ms"`) so downstream log scrapers and
 * error-string assertions keep working.
 */
export function withHookTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
    return withDeadline(promise, {
        timeoutMs: HOOK_TIMEOUT_MS,
        code: "HOOK_TIMEOUT",
        label: `${label} hook`,
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
    /**
     * Thunk over the loaded skill list — used by the reinjector hook in
     * SkillTool. A thunk, not a snapshot array: `SessionRegistry.skills` is
     * mutable (`updateSkills()` swaps it on hot reload), and the reinjector
     * runs on every context build for the lifetime of the harness, so a
     * captured array would keep restoring bodies from whatever skill set
     * existed when the session attached.
     */
    getSkills?: () => readonly Skill[];
    /**
     * Thunk that reads the current compaction threshold live (supplied by
     * AttachedSession, same source as `effectiveCompaction`). The pin-aware
     * compact hook uses it to recompute `keepRecentTokens` as
     * `contextWindow × threshold × 0.5`, fixing pi's hard-coded 20000 which
     * makes low-threshold compactions ineffective. Falls back to 0.7.
     */
    getCompactionThreshold?: () => number;
    /**
     * Thunk reading the current thinking level. Supplied by AttachedSession,
     * which caches it — pi 0.85's `lane.getThinkingLevel()` is async but this
     * hook has to decide synchronously on every context build.
     */
    getThinkingLevel: () => ThinkingLevel;
    /**
     * Model registry, used by the pin-aware compaction hook to resolve the
     * summarisation model. Was `harness.models` pre-0.85; the harness no longer
     * exposes it, so the caller passes it through.
     */
    models: Models;
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

/**
 * What a `transform_context` handler may return.
 *
 * pi 0.85 chains these handlers: each one receives the previous handler's
 * `messages`, and `undefined` means "no change". The pre-0.85 bus was
 * last-writer-wins over the ORIGINAL messages, which is why the old wiring
 * needed a trailing safety-net hook to re-assert in-place mutations. Chaining
 * makes that unnecessary.
 */
type ContextHookResult = { messages?: AgentMessage[] } | undefined;

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
    lane: AgentLane,
    opts: HookWiringOptions,
): Promise<WireHarnessResult> {
    const disposers: Array<() => void> = [];
    let skillReinjector: SkillReinjectorHandle | undefined;

    /**
     * Adapt a sidecar context hook to pi's `transform_context` contract.
     *
     * The two differ in one way that matters: pi's event also carries
     * `systemPrompt`, and its handlers chain. Our hooks only ever rewrite
     * `messages`, so returning just that field leaves the system prompt to
     * whichever hook (if any) owns it.
     */
    const onContext = (
        hook: (event: ContextEvent) => ContextHookResult | Promise<ContextHookResult>,
    ): (() => void) =>
        harness.hooks.on("transform_context", async (event) => {
            const result = await hook({ messages: event.messages });
            return result?.messages === undefined ? undefined : { messages: result.messages };
        });

    /**
     * Adapt a sidecar tool-call hook to pi's `before_tool` contract.
     *
     * Two shape differences: the extension API names the arguments `input`
     * (pi: `args`) and reports refusal as a flat `{block, reason}` (pi: a
     * nested `{block: {reason}}`, whose presence alone is the refusal).
     */
    const onToolCall = (
        hook: (
            event: ToolCallEvent,
        ) => ToolCallResult | undefined | Promise<ToolCallResult | undefined>,
    ): (() => void) =>
        harness.hooks.on("before_tool", async (event) => {
            const result = await hook({
                type: "tool_call",
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                input: event.args,
            });
            if (result?.block !== true) return undefined;
            return { block: { reason: result.reason ?? "blocked" } };
        });

    /**
     * Adapt a sidecar tool-result hook to pi's `after_tool` contract.
     *
     * `details` is `unknown` on our side but must be `JsonValue` for pi, which
     * persists it on the entry. The cast is safe in practice — hooks only ever
     * put JSON-serialisable data there — and pi validates on commit.
     */
    const onToolResult = (
        hook: (
            event: ToolResultEvent,
        ) => ToolResultPatch | undefined | Promise<ToolResultPatch | undefined>,
    ): (() => void) =>
        harness.hooks.on("after_tool", async (event) => {
            const result = await hook({
                type: "tool_result",
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                input: event.args,
                content: event.content as ToolResultEvent["content"],
                details: event.details,
                isError: event.isError,
                ...(event.usage === undefined ? {} : { usage: event.usage }),
            });
            if (result === undefined) return undefined;
            return {
                ...(result.content === undefined
                    ? {}
                    : { content: result.content as AgentToolResult<unknown>["content"] }),
                ...(result.details === undefined ? {} : { details: result.details as JsonValue }),
                ...(result.isError === undefined ? {} : { isError: result.isError }),
                ...(result.usage === undefined ? {} : { usage: result.usage }),
                ...(result.terminate === undefined ? {} : { terminate: result.terminate }),
            };
        });

    // ── protocol context hooks (trusted, not wrapped) ──
    // 1. strip `drop` policy tags before LLM conversion
    disposers.push(onContext(buildDropPolicyContextHook()));
    // 2. prepend `<instructions>` (CLAUDE.md), throttled so unchanged content
    //    is only re-injected every 20 turns at most. After compaction the old
    //    copy is gone (instructions is a `drop` tag), so the skip cap ensures
    //    the model periodically re-receives CLAUDE.md.
    disposers.push(
        onContext(
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
    disposers.push(onContext(buildEnvContextHook()));
    // 3b. append `<im_channel>` (channel type + id) for IM sessions only. The
    //     getter yields undefined for non-IM workspaces so this is a no-op there.
    if (opts.getImChannelContext) {
        disposers.push(onContext(buildImChannelContextHook(opts.getImChannelContext)));
    }
    // 4. prepend `<reply_language>` whenever getUiLocale() returns a value —
    //    content is stable across turns unless the user switches UI language
    //    (rare), so wrap in throttleByContent to skip redundant re-injection.
    if (opts.getUiLocale) {
        disposers.push(
            onContext(
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
    disposers.push(onContext(buildStripThinkingContextHook(opts.getThinkingLevel)));
    // 6. plan mode directive: while plan mode is active, inject a read-only
    //    planning prompt that guides the model to use the explorer subagent.
    const getActiveTasksState = opts.getActiveTasksState;
    if (getActiveTasksState) {
        disposers.push(onContext(buildPlanModeContextHook(() => getActiveTasksState().planState)));
    }
    // 7. skill body reinjection: drain pending queue + restore compacted-away skill bodies
    //
    // Gated on the thunk being supplied at all, not on it being non-empty right
    // now: a workspace that starts with zero skills but gets one hot-loaded
    // later needs this hook installed from the start, since it is wired once
    // per harness and cannot be added after attach. `SkillStore.skills` is a
    // getter (not a captured array) so every hook invocation re-reads the
    // live list through `getSkills`.
    const getSkills = opts.getSkills;
    if (getSkills) {
        const { hook, handle } = buildSkillReinjector({
            get skills() {
                return getSkills();
            },
        });
        disposers.push(onContext(hook));
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
        models: opts.models,
        getModel: () => lane.getModel(harnessContext),
        getBranchEntries: () => lane.findEntries({ order: "oldestFirst" }, harnessContext),
        getThreshold: opts.getCompactionThreshold ?? (() => 0.7),
    });
    disposers.push(
        harness.hooks.on("before_compaction", async (event) => {
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
            onContext(
                throttleByContent(buildMemoryContextHook(opts.memoryStore, opts.pinOnceConsumer)),
            ),
        );
    }

    // ── task-driven context hooks (both gated on getActiveTasksState) ──
    //  - active_tasks: continuation guidance for unfinished tasks
    //  - todo_reminder: nags when TodoWrite unused 10+ assistant turns
    if (opts.getActiveTasksState) {
        const getState = opts.getActiveTasksState;
        disposers.push(onContext(buildActiveTasksContextHook(getState)));
        disposers.push(onContext(buildTodoWriteReminderContextHook(() => getState().store)));
    }

    // ── extension context hooks (wrapped, errors → undefined) ──
    const extCtxHooks = opts.extensionContextHooks ?? { builtins: [], external: [] };
    const allExtCtxHooks = [
        ...extCtxHooks.builtins.map((h) => wrapContextHook(h, "ext-builtin")),
        ...extCtxHooks.external.map((h) => wrapContextHook(h, "ext-external")),
    ];
    for (const wrapped of allExtCtxHooks) {
        disposers.push(onContext(wrapped));
    }

    // ── compaction_reminder context hook — fires once after each compaction.
    //    Registered LAST so its unshift lands on top of every other hook's
    //    output: `transform_context` chains, so the last handler sees the fully
    //    transformed message list.
    disposers.push(onContext(compactionReminder.hook));

    // ── extension tool_call / tool_result hooks (wrapped) ──
    // before_tool fails CLOSED: `undefined` means "allow", so a gatekeeper hook
    // that hangs or throws would silently permit the very call it exists to
    // block. Timing out into a `block` is the safe direction — the tool call is
    // refused with a reason instead of slipping through.
    for (const hook of opts.extensionToolCallHooks ?? []) {
        disposers.push(
            onToolCall(
                wrapHook(hook, "tool_call", () => ({
                    block: true,
                    reason: "tool_call hook failed or timed out; blocking to fail closed",
                })),
            ),
        );
    }
    // ── mutation gate (trusted) ──
    // Registration order is no longer a correctness requirement for blocking:
    // pi 0.85's `before_tool` short-circuits on the first hook that returns a
    // `block`, so an extension can no longer overwrite the gate's refusal (the
    // pre-0.85 bus was last-writer-wins, which is why the gate had to be last).
    // It stays last so arg rewrites from extensions are visible to the gate.
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
            onToolCall(
                wrapHook(gate, "mutation-gate", () => ({
                    block: true,
                    reason: "mutation gate failed or timed out; blocking to fail closed",
                })),
            ),
        );
    }

    const extToolResultHooks = opts.extensionToolResultHooks ?? { builtins: [], external: [] };
    for (const hook of extToolResultHooks.builtins) {
        disposers.push(onToolResult(wrapHook(hook, "tool_result:builtin")));
    }
    for (const hook of extToolResultHooks.external) {
        disposers.push(onToolResult(wrapHook(hook, "tool_result:external")));
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
            harness.hooks.on("before_payload", (event) => {
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
