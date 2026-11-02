/**
 * Budget awareness for a running subagent.
 *
 * A subagent's turn cap and wall-clock budget are enforced by the runtime,
 * not by the model: the cap aborts the child mid-turn and whatever it had
 * written is what the parent gets. A model that knows it is near the end
 * behaves differently — it delivers its findings instead of opening one more
 * line of investigation — so the runtime tells it, once the run gets close.
 *
 * The reminder is injected as a context tag at the tail of the message list
 * (see `appendUserTag`), never into the system prompt: the system prompt is
 * the model's cache prefix, and a per-turn value there would miss the cache
 * on every turn. A tail tag leaves the prefix byte-identical.
 */

import type { ContextEvent, ContextResult } from "../../extensions/types.ts";
import { appendUserTag } from "../../tags/appendUserTag.ts";
import { tagWrap } from "../../tags/builder.ts";

/**
 * The budget of one subagent run, read live by the reminder hook.
 *
 * Mutable on purpose: the runner owns the counters, and the hook reads them
 * through a thunk so a value captured at spawn time cannot go stale.
 */
export interface SubagentBudgetState {
    /**
     * Turns this run may still take. Undefined = the profile set no turn cap,
     * so there is no turn budget to warn about.
     */
    maxTurns?: number;
    /** Turns completed so far. Updated by the runner on every `turn_end`. */
    turnsUsed: number;
    /** Wall-clock start of this run, in epoch ms. */
    startedAt: number;
    /**
     * The run's wall-clock budget in ms. Undefined for a synchronous run,
     * which the parent's turn already bounds, and for a run with no timeout.
     */
    timeoutMs?: number;
}

/**
 * Turns left at which the reminder starts firing: 10% of the budget, and at
 * least 5. A large budget needs a larger absolute margin to matter, but a
 * small one must not warn on its first turn.
 */
const TURN_MARGIN_RATIO = 0.1;
const MIN_TURN_MARGIN = 5;

/**
 * Wall-clock left at which the reminder starts firing: 10% of the budget, and
 * at least two minutes. Two minutes is roughly one model round trip plus a
 * tool call — enough for the model to deliver a final answer.
 */
const TIME_MARGIN_RATIO = 0.1;
const MIN_TIME_MARGIN_MS = 2 * 60_000;

/**
 * Render the budget line, or undefined when the run is not near its limit.
 *
 * Only the dimensions that apply are rendered: a profile with no turn cap
 * gets no turn count, and a synchronous run gets no clock.
 */
export function renderBudgetReminder(budget: SubagentBudgetState, now: number): string | undefined {
    const lines: string[] = [];

    if (budget.maxTurns !== undefined && budget.maxTurns > 0) {
        const left = budget.maxTurns - budget.turnsUsed;
        const margin = Math.max(MIN_TURN_MARGIN, Math.ceil(budget.maxTurns * TURN_MARGIN_RATIO));
        if (left <= margin) {
            lines.push(`Turn ${budget.turnsUsed}/${budget.maxTurns} (${left} left).`);
        }
    }

    if (budget.timeoutMs !== undefined && budget.timeoutMs > 0) {
        const remainingMs = budget.startedAt + budget.timeoutMs - now;
        const margin = Math.max(MIN_TIME_MARGIN_MS, budget.timeoutMs * TIME_MARGIN_RATIO);
        if (remainingMs <= margin) {
            const elapsedMin = Math.floor((now - budget.startedAt) / 60_000);
            const leftMin = Math.max(0, Math.ceil(remainingMs / 60_000));
            lines.push(`Time: ${elapsedMin}m elapsed, ${leftMin}m left.`);
        }
    }

    if (lines.length === 0) return undefined;
    return [
        ...lines,
        "You are near the limit of this run. If the task is substantially complete, deliver your",
        "final answer now. Otherwise finish the most valuable remaining check and report what you",
        "have found — do not start new lines of investigation.",
    ].join("\n");
}

/**
 * Build the context hook that injects `<subagent_budget>` near the run's end.
 *
 * Returns undefined from the hook — leaving the message list untouched — for
 * every turn that is not near a limit, so the steady state adds nothing to
 * the request and the cache prefix never moves.
 */
export function buildSubagentBudgetContextHook(
    getBudget: () => SubagentBudgetState | undefined,
): (event: ContextEvent) => ContextResult | undefined {
    return (event: ContextEvent): ContextResult | undefined => {
        const budget = getBudget();
        if (!budget) return undefined;
        const body = renderBudgetReminder(budget, Date.now());
        if (body === undefined) return undefined;
        appendUserTag(event.messages, tagWrap("subagent_budget", body), "system-event");
        return { messages: event.messages };
    };
}
