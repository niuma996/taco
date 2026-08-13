/**
 * Memory extraction coordinator — pure slicing helper + Promise-chain race coverage.
 * Two pieces: `sliceForExtraction` (tested directly) and the coordination pattern
 * (simulates AttachedSession events against mocked Session/MemoryExtractor).
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { sliceForExtraction } from "../../src/memory/index.ts";

// ─── helpers ──────────────────────────────────────────────────────────────────

// AgentMessage is a discriminated union; the test only cares about identity
// for slicing, so we cast through `unknown` and probe fields via `role` /
// stringified payload.
const msg = (role: AgentMessage["role"], content: string): AgentMessage =>
    ({ role, content }) as unknown as AgentMessage;

const messages = (n: number): AgentMessage[] =>
    Array.from({ length: n }, (_, i) => msg("user", `m${i}`));

/** Identity probe: every fixture has role=+content; stringify both for a
 *  cheap equality check that survives the discriminated-union cast. */
const identify = (m: AgentMessage): string =>
    `${m.role}:${(m as unknown as { content: string }).content}`;

// ─── sliceForExtraction ───────────────────────────────────────────────────────

describe("sliceForExtraction", () => {
    const all = messages(5);

    it("returns full messages when sinceCount is undefined", () => {
        const out = sliceForExtraction(all, undefined);
        assert.equal(out.length, 5);
        assert.ok(out[0]);
        assert.ok(out[4]);
        assert.equal(identify(out[0]), "user:m0");
        assert.equal(identify(out[4]), "user:m4");
        // MUST be a copy — caller may mutate
        assert.notEqual(out, all);
    });

    it("returns messages from offset when sinceCount is in range", () => {
        const out = sliceForExtraction(all, 3);
        assert.equal(out.length, 2);
        assert.ok(out[0]);
        assert.ok(out[1]);
        assert.equal(identify(out[0]), "user:m3");
        assert.equal(identify(out[1]), "user:m4");
    });

    it("returns full messages when sinceCount is 0", () => {
        const out = sliceForExtraction(all, 0);
        assert.equal(out.length, 5);
        assert.ok(out[0]);
        assert.equal(identify(out[0]), "user:m0");
    });

    it("returns empty array when sinceCount equals length (no new messages)", () => {
        const out = sliceForExtraction(all, all.length);
        assert.equal(out.length, 0);
    });

    it("returns empty array when sinceCount exceeds length (defensive)", () => {
        const out = sliceForExtraction(all, all.length + 10);
        assert.equal(out.length, 0);
    });

    it("clamps negative sinceCount to 0 (defensive)", () => {
        const out = sliceForExtraction(all, -5);
        assert.equal(out.length, 5);
        assert.ok(out[0]);
        assert.equal(identify(out[0]), "user:m0");
    });

    it("returns [] when input is [] regardless of sinceCount", () => {
        assert.equal(sliceForExtraction([], undefined).length, 0);
        assert.equal(sliceForExtraction([], 0).length, 0);
        assert.equal(sliceForExtraction([], 3).length, 0);
    });
});

// ─── coordination pattern ─────────────────────────────────────────────────────
//
// Mirror of the AttachedSession event handler block. Uses the SAME Promise
// chain structure as production code so a regression in the algorithm surfaces
// here. Mocks stand in for `session.buildContext()` and `extractor.onTurnEnd`.

interface MiniSession {
    buildContext: () => Promise<{ messages: AgentMessage[] }>;
}

interface MiniExtractor {
    onTurnEnd: (messages: readonly AgentMessage[]) => Promise<void>;
    /** Capture every messages slice we ever call onTurnEnd with. */
    calls: AgentMessage[][];
}

function makeExtractor(): MiniExtractor {
    const calls: AgentMessage[][] = [];
    return {
        calls,
        onTurnEnd: async (m) => {
            calls.push(m.slice());
        },
    };
}

/**
 * Mini-coordinator: a faithful copy of the AttachedSession block. If you
 * refactor one, refactor the other. Each `tool_execution_end` event flips a
 * shared state; each `turn_end` event consumes it. We intentionally avoid
 * linking to AttachedSession so the test stays O(constant) and doesn't have
 * to mock AgentHarness.
 */
function makeCoordinator(deps: {
    session: MiniSession;
    extractor: MiniExtractor;
    state: { lastRememberMessageCountPromises: Promise<number>[] };
}) {
    const { session, extractor, state } = deps;

    const handleToolExecutionEnd = (toolName: string, isError: boolean) => {
        if (toolName !== "memory" || isError) return;
        state.lastRememberMessageCountPromises.push(
            session.buildContext().then((ctx) => ctx.messages.length),
        );
    };

    const handleTurnEnd = () => {
        const promises = state.lastRememberMessageCountPromises;
        state.lastRememberMessageCountPromises = [];
        void session.buildContext().then(async (ctx) => {
            let sinceCount: number | undefined;
            if (promises.length > 0) {
                try {
                    const counts = await Promise.all(promises);
                    sinceCount = Math.min(...counts);
                } catch {
                    sinceCount = undefined;
                }
            }
            const messages = sliceForExtraction(ctx.messages, sinceCount);
            if (messages.length > 0) {
                await extractor.onTurnEnd(messages);
            }
        });
    };

    return { handleToolExecutionEnd, handleTurnEnd };
}

// Drain the microtask queue: every `.then()` schedules a microtask, and
// `await` inside one schedules another. Two ticks is enough for any chain
// in these tests.
const flush = () => new Promise<void>((r) => setImmediate(r));

describe("memory extraction coordinator — Promise-chain serialization", () => {
    const freshState = (): { lastRememberMessageCountPromises: Promise<number>[] } => ({
        lastRememberMessageCountPromises: [],
    });

    it("turn_end with no prior remember gets the full conversation", async () => {
        const extractor = makeExtractor();
        const session: MiniSession = {
            buildContext: () => Promise.resolve({ messages: messages(4) }),
        };
        const state = freshState();
        const { handleTurnEnd } = makeCoordinator({ session, extractor, state });

        handleTurnEnd();
        await flush();

        assert.equal(extractor.calls.length, 1);
        assert.equal(extractor.calls[0]?.length, 4);
        assert.ok(extractor.calls[0]?.[0]);
        assert.equal(identify(extractor.calls[0][0]), "user:m0");
    });

    it("tool_execution_end('memory') then turn_end slices to messages after the offset", async () => {
        const extractor = makeExtractor();
        // First buildContext (from remember tool) sees 3 messages; turn_end
        // sees 5 — extractor should receive only [m3, m4].
        let buildIndex = 0;
        const session: MiniSession = {
            buildContext: () => {
                buildIndex++;
                return Promise.resolve({ messages: messages(buildIndex === 1 ? 3 : 5) });
            },
        };
        const state = freshState();
        const { handleToolExecutionEnd, handleTurnEnd } = makeCoordinator({
            session,
            extractor,
            state,
        });

        handleToolExecutionEnd("memory", false);
        await flush(); // let the remember Promise resolve to 3
        handleTurnEnd();
        await flush();

        assert.equal(extractor.calls.length, 1);
        assert.equal(extractor.calls[0]?.length, 2);
        assert.ok(extractor.calls[0]?.[0]);
        assert.ok(extractor.calls[0]?.[1]);
        assert.equal(identify(extractor.calls[0][0]), "user:m3");
        assert.equal(identify(extractor.calls[0][1]), "user:m4");
    });

    it("turn_end reset clears the slot synchronously even when the remember count is still pending", async () => {
        const extractor = makeExtractor();
        // Both buildContext calls return the same length → after slicing
        // there's nothing new to extract. The interesting assertion is the
        // synchronous reset, plus that the algorithm doesn't crash or emit
        // a stale full extract.
        const session: MiniSession = {
            buildContext: () => Promise.resolve({ messages: messages(2) }),
        };
        const state = freshState();
        const { handleToolExecutionEnd, handleTurnEnd } = makeCoordinator({
            session,
            extractor,
            state,
        });

        // Fire tool_execution_end but DON'T flush — the count Promise is
        // still pending when turn_end runs.
        handleToolExecutionEnd("memory", false);
        handleTurnEnd(); // synchronously consumes the pending Promise into `sinceCountPromise`

        // Before flush: the slot is already empty (synchronous reset).
        assert.equal(state.lastRememberMessageCountPromises.length, 0);

        await flush();
        // 2 messages total, offset 2 → slice is empty → no extractor call.
        // This is the correct outcome: turn_end saw the offset even though
        // its own buildContext raced ahead of the remember count's resolve.
        assert.equal(extractor.calls.length, 0);
    });

    it("two turn_ends in a row without remember both see full conversations", async () => {
        const extractor = makeExtractor();
        const session: MiniSession = {
            buildContext: () => Promise.resolve({ messages: messages(4) }),
        };
        const state = freshState();
        const { handleTurnEnd } = makeCoordinator({ session, extractor, state });

        handleTurnEnd();
        handleTurnEnd();
        await flush();

        assert.equal(extractor.calls.length, 2);
        assert.equal(extractor.calls[0]?.length, 4);
        assert.equal(extractor.calls[1]?.length, 4);
    });

    it("turn_end skips onTurnEnd when the sliced range is empty", async () => {
        const extractor = makeExtractor();
        // Remember tool sees 5 messages, turn_end sees 5 — no new messages.
        let _buildIndex = 0;
        const session: MiniSession = {
            buildContext: () => {
                _buildIndex++;
                return Promise.resolve({ messages: messages(5) });
            },
        };
        const state = freshState();
        const { handleToolExecutionEnd, handleTurnEnd } = makeCoordinator({
            session,
            extractor,
            state,
        });

        handleToolExecutionEnd("memory", false);
        await flush();
        handleTurnEnd();
        await flush();

        assert.equal(extractor.calls.length, 0);
    });

    it("remember tool with isError=true does NOT capture an offset", async () => {
        const extractor = makeExtractor();
        const session: MiniSession = {
            buildContext: () => Promise.resolve({ messages: messages(3) }),
        };
        const state = freshState();
        const { handleToolExecutionEnd, handleTurnEnd } = makeCoordinator({
            session,
            extractor,
            state,
        });

        handleToolExecutionEnd("memory", true); // ERROR → no capture
        assert.equal(state.lastRememberMessageCountPromises.length, 0);
        handleTurnEnd();
        await flush();

        assert.equal(extractor.calls.length, 1);
        assert.equal(extractor.calls[0]?.length, 3);
    });

    it("non-memory tool does NOT capture an offset", async () => {
        const extractor = makeExtractor();
        const session: MiniSession = {
            buildContext: () => Promise.resolve({ messages: messages(3) }),
        };
        const state = freshState();
        const { handleToolExecutionEnd, handleTurnEnd } = makeCoordinator({
            session,
            extractor,
            state,
        });

        handleToolExecutionEnd("read", false);
        handleToolExecutionEnd("write", false);
        assert.equal(state.lastRememberMessageCountPromises.length, 0);
        handleTurnEnd();
        await flush();

        assert.equal(extractor.calls.length, 1);
        assert.equal(extractor.calls[0]?.length, 3);
    });

    it("two memory calls in same turn: uses earliest offset so no messages are lost", async () => {
        const extractor = makeExtractor();
        // messages sequence: after first remember → 3 messages, after second → 5.
        // earliest offset = 3, so messages[3..] are new (m3, m4).
        let resolveFirst: ((v: { messages: AgentMessage[] }) => void) | undefined;
        let resolveSecond: ((v: { messages: AgentMessage[] }) => void) | undefined;
        const _firstDone = new Promise<void>(() => {
            resolveFirst = (_v) => {};
        });
        const _secondDone = new Promise<void>(() => {
            resolveSecond = (_v) => {};
        });
        // Replace with real promises.
        const firstPromise = new Promise<{ messages: AgentMessage[] }>((r) => {
            resolveFirst = r;
        });
        const secondPromise = new Promise<{ messages: AgentMessage[] }>((r) => {
            resolveSecond = r;
        });
        let buildIndex = 0;
        const session: MiniSession = {
            buildContext: () => {
                buildIndex++;
                if (buildIndex === 1) return firstPromise;
                if (buildIndex === 2) return secondPromise;
                // turn_end's own buildContext — sees 10 messages total.
                return Promise.resolve({ messages: messages(10) });
            },
        };
        const state = freshState();
        const { handleToolExecutionEnd, handleTurnEnd } = makeCoordinator({
            session,
            extractor,
            state,
        });

        // Fire both memory calls — both Promises are pending.
        handleToolExecutionEnd("memory", false);
        handleToolExecutionEnd("memory", false);
        // Verify both went into the array before either resolves.
        assert.equal(state.lastRememberMessageCountPromises.length, 2);

        // Fire turn_end synchronously — it takes ownership of the array.
        handleTurnEnd();
        // Synchronous reset: the fresh array is empty.
        assert.equal(state.lastRememberMessageCountPromises.length, 0);

        // Now resolve the remember Promises — second has earlier count (3) than first (5).
        if (resolveSecond) resolveSecond({ messages: messages(3) });
        if (resolveFirst) resolveFirst({ messages: messages(5) });
        await flush();

        // Earliest offset = 3, so messages[3..10] = 7 messages extracted.
        assert.equal(extractor.calls.length, 1);
        assert.equal(extractor.calls[0]?.length, 7);
        assert.equal(identify(extractor.calls[0][0]), "user:m3");
    });

    it("rejected countPromise falls back to full messages (no duplicate / no crash)", async () => {
        const extractor = makeExtractor();
        let buildIndex = 0;
        const session: MiniSession = {
            buildContext: () => {
                buildIndex++;
                // First call (the remember capture) rejects.
                if (buildIndex === 1) return Promise.reject(new Error("session boom"));
                return Promise.resolve({ messages: messages(4) });
            },
        };
        const state = freshState();
        const { handleToolExecutionEnd, handleTurnEnd } = makeCoordinator({
            session,
            extractor,
            state,
        });

        handleToolExecutionEnd("memory", false);
        handleTurnEnd();
        await flush();

        // Should not throw; should emit full conversation since offset is
        // swallowed by the catch.
        assert.equal(extractor.calls.length, 1);
        assert.equal(extractor.calls[0]?.length, 4);
    });
});
