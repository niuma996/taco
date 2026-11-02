import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { AgentMessage } from "../../src/runtime/pi/types.ts";
import {
    buildSubagentBudgetContextHook,
    renderBudgetReminder,
    type SubagentBudgetState,
} from "../../src/tags/subagentBudget.ts";

const NOW = 1_800_000_000_000;

function budget(overrides: Partial<SubagentBudgetState> = {}): SubagentBudgetState {
    return { turnsUsed: 0, startedAt: NOW, ...overrides };
}

function messages(): AgentMessage[] {
    // Two user messages rather than a user/assistant pair: the assertion is
    // about the prefix staying byte-identical, and a user message needs no
    // provider bookkeeping.
    return [
        { role: "user", content: [{ type: "text", text: "first" }], timestamp: NOW },
        { role: "user", content: [{ type: "text", text: "second" }], timestamp: NOW },
    ];
}

describe("renderBudgetReminder", () => {
    it("says nothing while the run is far from its turn limit", () => {
        const out = renderBudgetReminder(budget({ maxTurns: 200, turnsUsed: 10 }), NOW);
        assert.equal(out, undefined);
    });

    it("warns once the run is inside the turn margin", () => {
        const out = renderBudgetReminder(budget({ maxTurns: 200, turnsUsed: 185 }), NOW);
        assert.ok(out);
        assert.match(out, /Turn 185\/200 \(15 left\)/);
    });

    it("keeps at least five turns of margin on a small budget", () => {
        // 10% of 20 is 2, but the floor is 5 — warning at turn 16 would be
        // noise, and the run needs room to deliver an answer.
        assert.equal(renderBudgetReminder(budget({ maxTurns: 20, turnsUsed: 14 }), NOW), undefined);
        assert.ok(renderBudgetReminder(budget({ maxTurns: 20, turnsUsed: 16 }), NOW));
    });

    it("says nothing about turns when the profile set no turn cap", () => {
        const out = renderBudgetReminder(budget({ turnsUsed: 900 }), NOW);
        assert.equal(out, undefined);
    });

    it("warns on the clock when the run nears its wall-clock limit", () => {
        const out = renderBudgetReminder(
            budget({ timeoutMs: 60 * 60_000, startedAt: NOW - 56 * 60_000 }),
            NOW,
        );
        assert.ok(out);
        assert.match(out, /Time: 56m elapsed, 4m left/);
    });

    it("says nothing about the clock when the run has no wall-clock budget", () => {
        const out = renderBudgetReminder(budget({ maxTurns: 200, turnsUsed: 10 }), NOW);
        assert.equal(out, undefined);
    });

    it("reports both dimensions when both are near their limit", () => {
        const out = renderBudgetReminder(
            budget({
                maxTurns: 20,
                turnsUsed: 18,
                timeoutMs: 60 * 60_000,
                startedAt: NOW - 56 * 60_000,
            }),
            NOW,
        );
        assert.ok(out);
        assert.match(out, /Turn 18\/20/);
        assert.match(out, /Time: 56m elapsed/);
    });

    it("guides without commanding an immediate stop", () => {
        const out = renderBudgetReminder(budget({ maxTurns: 20, turnsUsed: 18 }), NOW);
        assert.ok(out);
        assert.match(out, /substantially complete/);
        assert.ok(!/\bstop\b/i.test(out));
    });
});

describe("buildSubagentBudgetContextHook", () => {
    it("injects nothing while the run is far from its limit", () => {
        const hook = buildSubagentBudgetContextHook(() => budget({ maxTurns: 200, turnsUsed: 1 }));
        const list = messages();
        assert.equal(hook({ messages: list }), undefined);
        assert.equal(list.length, 2);
    });

    it("injects nothing when there is no budget at all", () => {
        const hook = buildSubagentBudgetContextHook(() => undefined);
        const list = messages();
        assert.equal(hook({ messages: list }), undefined);
        assert.equal(list.length, 2);
    });

    it("appends the budget tag at the tail", () => {
        const hook = buildSubagentBudgetContextHook(() => budget({ maxTurns: 20, turnsUsed: 18 }));
        const list = messages();
        const result = hook({ messages: list });
        assert.ok(result);
        assert.equal(list.length, 3);
        const appended = list[2];
        assert.equal(appended.role, "user");
        const text = JSON.stringify(appended.content);
        assert.match(text, /subagent_budget/);
        assert.match(text, /Turn 18\/20/);
    });

    it("leaves the conversation prefix byte-identical so the cache still hits", () => {
        const hook = buildSubagentBudgetContextHook(() => budget({ maxTurns: 20, turnsUsed: 18 }));
        const list = messages();
        const before = JSON.stringify(list);
        hook({ messages: list });
        // Only the tail grew: everything before it is unchanged.
        assert.equal(JSON.stringify(list.slice(0, 2)), before);
    });
});

describe("budget reminder throttle", () => {
    it("re-injects at most once per three turns", () => {
        const budget = { turnsUsed: 18, startedAt: NOW, maxTurns: 20 };
        const hook = buildSubagentBudgetContextHook(() => budget);

        assert.ok(hook({ messages: messages() }), "first crossing injects");
        assert.equal(hook({ messages: messages() }), undefined, "same turn stays silent");

        budget.turnsUsed = 19;
        assert.equal(hook({ messages: messages() }), undefined, "same bucket stays silent");

        budget.turnsUsed = 21;
        assert.ok(hook({ messages: messages() }), "next bucket injects again");
    });

    it("resets the throttle when a resumed run supplies a new budget", () => {
        let current: SubagentBudgetState = { turnsUsed: 18, startedAt: NOW, maxTurns: 20 };
        const hook = buildSubagentBudgetContextHook(() => current);
        assert.ok(hook({ messages: messages() }));

        current = { turnsUsed: 18, startedAt: NOW, maxTurns: 20 };
        assert.ok(
            hook({ messages: messages() }),
            "a new run's budget is not throttled by the old one",
        );
    });
});
