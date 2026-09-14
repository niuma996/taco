/**
 * `wireHarnessHooks` registers the skill reinjector with a live
 * `getSkills()` thunk, not a constructor-time snapshot of `this.skills`.
 *
 * Before this fix, `hookWiring.ts:387` called
 * `buildSkillReinjector({ skills: opts.skills })` with a frozen reference
 * captured at harness attach. When `SessionRegistry.updateSkills()` later
 * swapped `this.skills` for a fresh array (hot reload, follow-up pipeline),
 * the already-installed reinjector kept restoring bodies from the
 * pre-reload list — sessions that invoked the new skill saw nothing, and
 * sessions that invoked a removed skill kept getting its body after the
 * reload log had acknowledged its death.
 *
 * The fix passes
 * `buildSkillReinjector({ get skills() { return getSkills(); } })`
 * — a getter the hook re-evaluates on every invocation. The test wires a
 * real hook chain, marks the skill invoked, mutates the underlying skill
 * list, fires every registered `transform_context` handler with an empty
 * message list, and asserts the reinjected body comes from the *new* list.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createModels } from "@earendil-works/pi-ai/compat";
import { wireHarnessHooks } from "../../src/runtime/harness/hookWiring.ts";
import type { AgentHarness, AgentLane, AgentMessage, Skill } from "../../src/runtime/pi/types.ts";

type TransformHandler = (event: {
    messages: AgentMessage[];
}) => Promise<{ messages?: AgentMessage[] } | undefined>;

/**
 * Minimal harness: records every `transform_context` handler it receives,
 * returns no-op disposers for everything else. Lets us drive the
 * skill-reinjector hook chain end-to-end without pi or the rest of the
 * AgentHarness surface.
 */
function makeHarness(): {
    harness: AgentHarness<never>;
    contextHandlers: TransformHandler[];
} {
    const contextHandlers: TransformHandler[] = [];
    const harness = {
        hooks: {
            on(type: string, handler: (event: unknown) => unknown) {
                if (type === "transform_context") {
                    contextHandlers.push(handler as TransformHandler);
                }
                return () => {};
            },
        },
    };
    return {
        harness: harness as unknown as AgentHarness<never>,
        contextHandlers,
    };
}

const minimalLane = {} as AgentLane;

const skillV1: Skill = {
    name: "echo",
    description: "v1",
    content: "echo v1 body",
    filePath: "/x/echo-v1.md",
};
const skillV2: Skill = {
    name: "echo",
    description: "v2",
    content: "echo v2 body — replaced after reload",
    filePath: "/x/echo-v2.md",
};

function bodyTexts(result: { messages?: AgentMessage[] } | undefined): string {
    const msgs = result?.messages ?? [];
    let s = "";
    for (const m of msgs) {
        const c = (m as { content?: unknown }).content;
        if (typeof c === "string") s += `${c}\n`;
    }
    return s;
}

async function fireAll(handlers: TransformHandler[]): Promise<string> {
    let combined = "";
    for (const handler of handlers) {
        const result = await handler({ messages: [] });
        combined += bodyTexts(result);
    }
    return combined;
}

describe("hookWiring — skill reinjector reads getSkills live", () => {
    it("a hot-reload of skills replaces the body the reinjector restores", async () => {
        let current: readonly Skill[] = [skillV1];
        const { harness, contextHandlers } = makeHarness();

        const { skillReinjector } = await wireHarnessHooks(harness, minimalLane, {
            cwd: "/tmp/ws",
            getSkills: () => current,
            getThinkingLevel: () => "off",
            models: createModels(),
        });

        assert.ok(
            skillReinjector,
            "wireHarnessHooks must return a skillReinjector handle when getSkills is supplied",
        );
        skillReinjector.markInvoked("echo");

        const before = await fireAll(contextHandlers);
        assert.ok(
            before.includes("echo v1 body"),
            `with v1 in the store, the reinjector must splice the v1 body, got: ${JSON.stringify(before)}`,
        );

        // Hot-reload — the workspace swaps its skills array. `getSkills` is
        // a thunk, so the next hook invocation re-reads the live list.
        current = [skillV2];

        const after = await fireAll(contextHandlers);
        assert.ok(
            after.includes("echo v2 body"),
            `after the swap, the reinjector must splice the v2 body, got: ${JSON.stringify(after)}`,
        );
        assert.ok(
            !after.includes("echo v1 body"),
            "stale v1 body must not appear after the store swapped lists",
        );
    });
});
