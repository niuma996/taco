import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { agentsWriteSchema } from "@taco-ai/protocol";
import { Value } from "typebox/value";
import { MAX_AGENT_TIMEOUT_MINUTES, MAX_AGENT_TURNS } from "../../src/agents/loadAgents.ts";
import { backgroundTimeoutMs } from "../../src/runtime/subagent/agentSpawner.ts";
import {
    isSubagentTimeoutReason,
    SUBAGENT_STOPPED_TEXT,
    subagentTimeoutText,
} from "../../src/runtime/subagent/subagentProgress.ts";

describe("backgroundTimeoutMs", () => {
    it("gives a 100-turn profile a budget it can actually reach", () => {
        // 10 minutes cut a real review off at turn 29 of 100.
        const ms = backgroundTimeoutMs(100);
        assert.ok(ms >= 40 * 60_000, `expected at least 40 minutes, got ${ms}`);
    });

    it("scales with the turn budget", () => {
        assert.ok(backgroundTimeoutMs(200) > backgroundTimeoutMs(60));
        assert.ok(backgroundTimeoutMs(60) > backgroundTimeoutMs(30));
    });

    it("never drops below the floor, whatever the turn budget", () => {
        assert.equal(backgroundTimeoutMs(1), 10 * 60_000);
        assert.equal(backgroundTimeoutMs(5), 10 * 60_000);
    });

    it("reaches the largest turn budget the protocol allows", () => {
        // A profile may declare MAX_AGENT_TURNS turns; the wall clock derived
        // from it must not cut the run short before the turn cap does.
        const ms = backgroundTimeoutMs(MAX_AGENT_TURNS);
        assert.equal(ms, MAX_AGENT_TURNS * 30_000);
        assert.ok(
            ms <= MAX_AGENT_TIMEOUT_MINUTES * 60_000,
            "an explicit budget may still exceed it",
        );
    });

    it("assumes a turn budget for a profile that sets none", () => {
        assert.equal(backgroundTimeoutMs(undefined), backgroundTimeoutMs(100));
        assert.equal(backgroundTimeoutMs(0), backgroundTimeoutMs(100));
    });
});

describe("limit ceilings", () => {
    it("the protocol schema caps the turn budget at the shared ceiling", () => {
        const base = {
            workspace: "/w",
            agentType: "reviewer",
            description: "Review code",
            systemPrompt: "Be precise",
        };
        assert.deepEqual(
            Value.Errors(agentsWriteSchema, { ...base, maxTurns: MAX_AGENT_TURNS }),
            [],
            "the shared ceiling must be writable",
        );
        assert.ok(
            Value.Errors(agentsWriteSchema, { ...base, maxTurns: MAX_AGENT_TURNS + 1 }).length > 0,
            "and one more must not be",
        );
    });

    it("the protocol schema caps the timeout at the shared ceiling", () => {
        const base = {
            workspace: "/w",
            agentType: "reviewer",
            description: "Review code",
            maxTurns: 10,
            systemPrompt: "Be precise",
        };
        assert.deepEqual(
            Value.Errors(agentsWriteSchema, {
                ...base,
                timeoutMinutes: MAX_AGENT_TIMEOUT_MINUTES,
            }),
            [],
        );
        assert.ok(
            Value.Errors(agentsWriteSchema, {
                ...base,
                timeoutMinutes: MAX_AGENT_TIMEOUT_MINUTES + 1,
            }).length > 0,
        );
    });
});

describe("subagent stop wording", () => {
    it("a user stop says the user stopped it", () => {
        assert.match(SUBAGENT_STOPPED_TEXT, /user aborted the parent session/);
        assert.equal(
            SUBAGENT_STOPPED_TEXT.includes("timeout"),
            false,
            "a timeout has its own wording; blending them reads as a user action",
        );
    });

    it("a timeout says how long it had and how far it got", () => {
        const text = subagentTimeoutText({ timeoutMinutes: 50, turnsUsed: 29 });
        assert.match(text, /50-minute/);
        assert.match(text, /29 turn/);
        assert.match(text, /time limit, not a failure/);
        assert.match(text, /chatToAgent|continuing that session/);
    });

    it("recognizes its own abort reason and nothing else", () => {
        assert.equal(
            isSubagentTimeoutReason({ kind: "subagent-timeout", timeoutMinutes: 10 }),
            true,
        );
        assert.equal(isSubagentTimeoutReason({ kind: "something-else" }), false);
        assert.equal(isSubagentTimeoutReason(undefined), false);
        assert.equal(isSubagentTimeoutReason("subagent-timeout"), false);
    });
});
