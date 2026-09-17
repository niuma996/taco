/**
 * Skill body message + argument interpolation.
 *
 * `interpolateArgs` is a local implementation that handles `$ARGUMENTS` with a
 * function replacer (safe from $$/$&/$'/$\` patterns in args) and falls back
 * to appending "Arguments: ..." when the body has no placeholder. Tested here
 * for the byte-for-byte invariants that callers depend on.
 *
 * Considered switching to pi-agent-core's `substituteArgs` to gain `$1` / `$2`
 * / `${@:N}` support, but pi's implementation has a string-replacement bug
 * for `$ARGUMENTS` that conflicts with this contract — kept local.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSkillBodyMessage, interpolateArgs } from "../../src/skills/skillMessages.ts";

/**
 * `createSkillBodyMessage` returns the wide `AgentMessage` union, but the
 * function always constructs a user message — narrow locally so the test
 * can read `.content` without touching the production return type.
 */
type SkillBodyMessage = { role: "user"; content: string; timestamp: number };

describe("interpolateArgs", () => {
    it("substitutes $ARGUMENTS with the provided args", () => {
        assert.equal(
            interpolateArgs("echo $ARGUMENTS please", "hello world"),
            "echo hello world please",
        );
    });

    it("substitutes every occurrence of $ARGUMENTS", () => {
        assert.equal(interpolateArgs("$ARGUMENTS / $ARGUMENTS", "x"), "x / x");
    });

    it("treats $$/$&/$' special replacement patterns in args as literals", () => {
        // Regression guard: function-replacer semantics must survive any
        // future refactor — without it, "$$1" in args would expand to "$1"
        // and the result would round-trip unpredictably across replacers.
        const result = interpolateArgs("got: $ARGUMENTS", "$$1 $& $' $`");
        assert.equal(result, "got: $$1 $& $' $`");
    });

    it("falls back to appending 'Arguments: ...' when no placeholder matches", () => {
        assert.equal(
            interpolateArgs("plain body", "the args"),
            "plain body\n\nArguments: the args",
        );
    });

    it("returns body unchanged when there is no placeholder and no args", () => {
        assert.equal(interpolateArgs("plain body", ""), "plain body");
    });
});

describe("createSkillBodyMessage", () => {
    it("wraps the body in <skill_body:NAME> and interpolates args", () => {
        const msg = createSkillBodyMessage({ name: "demo", content: "say $ARGUMENTS" }, "hi");
        assert.equal(msg.role, "user");
        assert.equal((msg as SkillBodyMessage).content, "<skill_body:demo>\n\nsay hi");
    });

    it("appends legacy 'Arguments: ...' when body has no placeholder", () => {
        const msg = createSkillBodyMessage(
            { name: "demo", content: "no placeholder here" },
            "the args",
        );
        assert.equal(
            (msg as SkillBodyMessage).content,
            "<skill_body:demo>\n\nno placeholder here\n\nArguments: the args",
        );
    });

    it("does not append when args is empty", () => {
        const msg = createSkillBodyMessage({ name: "demo", content: "no placeholder here" }, "");
        assert.equal((msg as SkillBodyMessage).content, "<skill_body:demo>\n\nno placeholder here");
    });
});
