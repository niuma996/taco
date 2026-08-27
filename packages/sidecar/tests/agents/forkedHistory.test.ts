/**
 * forkedHistory — buildForkedContext + estimateTokens (pure functions).
 * Run: cd packages/sidecar && pnpm exec tsx --test tests/agents/forkedHistory.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";
import {
    buildForkedContext,
    estimateTokens,
    resolveContextMode,
} from "../../src/agents/forkedHistory.ts";

/** Minimal message entries; cast once so the tests read as fixtures, not wire types. */
function entries(
    msgs: Array<{ role: "user" | "assistant" | "toolResult"; text: string }>,
): SessionTreeEntry[] {
    return msgs.map((m, i) => ({
        type: "message",
        id: `id-${i}`,
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: m.role, content: m.text },
    })) as unknown as SessionTreeEntry[];
}

describe("resolveContextMode", () => {
    // All 9 (arg, def) combinations. The call site wins whenever it is set —
    // including when it asks to DOWNGRADE a fork-declaring profile back to
    // independent. Silently ignoring that would make the tool parameter lie.
    const cases: Array<{
        arg: "independent" | "fork" | undefined;
        def: "independent" | "fork" | undefined;
        want: "independent" | "fork";
    }> = [
        { arg: undefined, def: undefined, want: "independent" },
        { arg: undefined, def: "independent", want: "independent" },
        { arg: undefined, def: "fork", want: "fork" },
        { arg: "independent", def: undefined, want: "independent" },
        { arg: "independent", def: "independent", want: "independent" },
        { arg: "independent", def: "fork", want: "independent" },
        { arg: "fork", def: undefined, want: "fork" },
        { arg: "fork", def: "independent", want: "fork" },
        { arg: "fork", def: "fork", want: "fork" },
    ];

    for (const { arg, def, want } of cases) {
        it(`arg=${String(arg)} def=${String(def)} → ${want}`, () => {
            assert.equal(resolveContextMode(arg, def), want);
        });
    }
});

describe("estimateTokens", () => {
    it("counts CJK chars ~1 token each and ASCII ~4 chars/token", () => {
        assert.equal(estimateTokens("你好"), 2);
        assert.equal(estimateTokens("abcd"), 1);
        assert.equal(estimateTokens("abcde"), 2);
    });
});

describe("buildForkedContext", () => {
    it("returns undefined when there is no displayable text", () => {
        assert.equal(buildForkedContext([]), undefined);
        // toolResult-only branch has no user/assistant text.
        assert.equal(
            buildForkedContext(entries([{ role: "toolResult", text: "shell output" }])),
            undefined,
        );
    });

    it("keeps the first message and backfills from the newest, skipping toolResults", () => {
        const ctx = buildForkedContext(
            entries([
                { role: "user", text: "original task" },
                { role: "assistant", text: "first assistant reply" },
                { role: "toolResult", text: "tool output (dropped)" },
                { role: "user", text: "follow-up question" },
                { role: "assistant", text: "final answer" },
            ]),
        );
        assert.ok(ctx, "expected a rendered block");
        assert.ok(ctx.includes("[user]\noriginal task"), "head kept");
        assert.ok(ctx.includes("[assistant]\nfinal answer"), "tail backfilled");
        assert.ok(ctx.includes("[user]\nfollow-up question"), "interior kept when budget allows");
        assert.ok(!ctx.includes("tool output"), "toolResult content dropped");
        assert.ok(!ctx.includes("…[earlier messages omitted]…"), "nothing omitted");
        assert.ok(ctx.includes("<forked_context>") && ctx.includes("</forked_context>"));
    });

    it("marks omitted messages when the budget forces a gap", () => {
        // Budget fits the head + the newest message but not the long middle
        // message; the middle must drop out, leaving an omission marker.
        const msgs = entries([
            { role: "user", text: "first" },
            { role: "assistant", text: "m".repeat(200) },
            { role: "assistant", text: "last" },
        ]);
        const ctx = buildForkedContext(msgs, { maxTokens: 7 });
        assert.ok(ctx, "expected a rendered block");
        assert.ok(ctx.includes("[user]\nfirst"), "head kept");
        assert.ok(ctx.includes("[assistant]\nlast"), "tail kept");
        assert.ok(!ctx.includes("m".repeat(200)), "middle dropped");
        assert.ok(ctx.includes("…[earlier messages omitted]…"), "gap marked");
    });

    it("truncates when the head alone exceeds the budget", () => {
        const ctx = buildForkedContext(entries([{ role: "user", text: "a very long task" }]), {
            maxTokens: 2,
        });
        assert.ok(ctx, "expected a rendered block");
        assert.ok(ctx.includes("…[truncated]…"), "head truncated to budget");
    });
});
