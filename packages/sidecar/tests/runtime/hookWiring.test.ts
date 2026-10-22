/**
 * hookWiring: the wrapHook / withHookTimeout guard and the skill reinjector's
 * live getSkills() wiring.
 */

import { strict as assert } from "node:assert";
import { describe, it, mock } from "node:test";
import { createModels } from "@earendil-works/pi-ai/compat";
import {
    HOOK_TIMEOUT_MS,
    wireHarnessHooks,
    withHookTimeout,
    wrapHook,
} from "../../src/runtime/harness/hookWiring.ts";
import type { AgentHarness, AgentLane, AgentMessage, Skill } from "../../src/runtime/pi/types.ts";

describe("withHookTimeout", () => {
    it("resolves fast promises with the original value", async () => {
        assert.equal(await withHookTimeout(Promise.resolve(42), "fast"), 42);
        assert.equal(await withHookTimeout(Promise.resolve("ok"), "fast"), "ok");
    });

    it("propagates rejections from fast promises", async () => {
        await assert.rejects(
            () => withHookTimeout(Promise.reject(new Error("boom")), "fast"),
            /boom/,
        );
    });
});

describe("wrapHook", () => {
    it("passes through a normal hook result", async () => {
        const wrapped = wrapHook((e: number) => e * 2, "double");
        assert.equal(await wrapped(21), 42);
    });

    it("degrades a sync-throwing hook to undefined", async () => {
        const wrapped = wrapHook(() => {
            throw new Error("sync boom");
        }, "thrower");
        assert.equal(await wrapped("x"), undefined);
    });

    it("degrades a rejecting hook to undefined", async () => {
        const wrapped = wrapHook(async () => {
            throw new Error("async boom");
        }, "rejector");
        assert.equal(await wrapped("x"), undefined);
    });

    it("times out a hung hook to undefined instead of blocking forever", async () => {
        // Mock setTimeout so the 2s deadline fires on a synthetic tick —
        // eliminates the wall-clock sensitivity that made this case
        // intermittently fail under full-suite event-loop pressure.
        mock.timers.enable({ apis: ["setTimeout"] });
        try {
            const wrapped = wrapHook(() => new Promise<never>(() => {}), "hanger");
            const hung = wrapped("x");
            mock.timers.tick(HOOK_TIMEOUT_MS);
            assert.equal(await hung, undefined);
        } finally {
            mock.timers.reset();
        }
    });

    it("uses the onFailure fallback so tool_call can fail closed", async () => {
        // tool_call treats `undefined` as "allow", so a gatekeeper hook that
        // throws or hangs must fall back to blocking rather than permitting.
        mock.timers.enable({ apis: ["setTimeout"] });
        try {
            const failClosed = (): { block: true; reason: string } => ({
                block: true,
                reason: "failed closed",
            });

            const thrower = wrapHook(
                () => {
                    throw new Error("gatekeeper exploded");
                },
                "tool_call",
                failClosed,
            );
            assert.deepEqual(await thrower("rm -rf /"), { block: true, reason: "failed closed" });

            const hanger = wrapHook(() => new Promise<never>(() => {}), "tool_call", failClosed);
            const hung = hanger("rm -rf /");
            mock.timers.tick(HOOK_TIMEOUT_MS);
            assert.deepEqual(await hung, { block: true, reason: "failed closed" });
        } finally {
            mock.timers.reset();
        }
    });
});

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
