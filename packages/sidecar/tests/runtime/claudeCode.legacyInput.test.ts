import assert from "node:assert/strict";
import { it } from "node:test";
import { asSessionId } from "@taco-ai/protocol";
import { ClaudeCodeInput } from "../../src/runtime/subagent/claudeCode/claudeCodeInput.ts";
import { runClaudeCodeSubagent } from "../../src/runtime/subagent/claudeCode/claudeCodeRunner.ts";
import type { SdkMessage } from "../../src/runtime/subagent/claudeCode/claudeCodeSdk.ts";

const result = (fields = {}): Extract<SdkMessage, { type: "result" }> => ({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 1,
    ...fields,
});

for (const queued of [undefined, 0]) {
    it(`stops ambiguous legacy inputs with queued_turn_count=${queued} instead of claiming completion`, async () => {
        const input = new ClaudeCodeInput(() => {});
        input.send("first", "1");
        input.send("second", "2");
        const iterator = input[Symbol.asyncIterator]();
        await iterator.next();
        await iterator.next();
        const blocked = iterator.next();
        assert.throws(
            () => input.complete(result({ queued_turn_count: queued })),
            /input delivery is uncertain/,
        );
        assert.equal((await blocked).done, true);
        assert.equal(input.send("third", "3"), false);
    });
}

it("does not turn pending-send counts into result counts when legacy prompts coalesce", async () => {
    const input = new ClaudeCodeInput(() => {});
    for (const id of ["1", "2", "3", "4"]) input.send(id, id);
    const iterator = input[Symbol.asyncIterator]();
    for (let i = 0; i < 4; i++) await iterator.next();
    input.complete(result({ queued_turn_count: 2 }));
    // Two sends may coalesce into just one remaining result; zero can also mean discarded backlog.
    assert.throws(
        () => input.complete(result({ queued_turn_count: 0 })),
        /input delivery is uncertain/,
    );
    assert.equal((await iterator.next()).done, true);
});

it("can recover full correlation after an uncorrelated result without guessing which input completed", async () => {
    const input = new ClaudeCodeInput(() => {});
    input.send("first", "1");
    input.send("second", "2");
    input.complete(result({ queued_turn_count: 1 }));
    // The first result must not have silently acknowledged message 1.
    assert.throws(
        () => input.complete(result({ user_message_uuids: ["2"], queued_turn_count: 0 })),
        /input delivery is uncertain/,
    );

    const correlated = new ClaudeCodeInput(() => {});
    correlated.send("first", "1");
    correlated.send("second", "2");
    correlated.complete(result({ queued_turn_count: 1 }));
    correlated.complete(result({ user_message_uuids: ["1", "2"], queued_turn_count: 0 }));
    assert.equal(correlated.send("third", "3"), false);
});

it("treats an empty UUID list as missing correlation", () => {
    const input = new ClaudeCodeInput(() => {});
    input.send("first", "1");
    input.send("second", "2");
    assert.throws(
        () => input.complete(result({ user_message_uuids: [], queued_turn_count: 0 })),
        /input delivery is uncertain/,
    );
});

it("preserves the single-input legacy path", async () => {
    const input = new ClaudeCodeInput(() => {});
    input.send("first", "1");
    const iterator = input[Symbol.asyncIterator]();
    await iterator.next();
    input.complete(result());
    assert.equal((await iterator.next()).done, true);
});

it("does not report success if the SDK ends with unresolved legacy delivery after promising another turn", async () => {
    const response = await runClaudeCodeSubagent({
        subSessionId: asSessionId("legacy-ended"),
        agentType: "cc",
        prompt: "first",
        cwd: "/work",
        abortController: new AbortController(),
        onInputReady: (input) => {
            input.send("second", "2");
        },
        appendMessages: async () => {},
        findExecutable: () => "/usr/local/bin/claude",
        loadSdk: async () => ({
            query: async function* () {
                yield {
                    type: "assistant",
                    message: { id: "a", content: [{ type: "text", text: "partial reply" }] },
                } as const;
                yield result({ queued_turn_count: 1 });
            },
        }),
    });
    assert.equal(response.isError, true);
    assert.match(response.resultText, /input delivery is uncertain/);
});

it("returns an uncertainty error, retains transcript, and closes the SDK without waiting for another result", {
    timeout: 1500,
}, async () => {
    let closed = false;
    let returned = false;
    let blocked: Promise<IteratorResult<unknown>> | undefined;
    const appended: unknown[] = [];
    const response = await runClaudeCodeSubagent({
        subSessionId: asSessionId("legacy-child"),
        agentType: "cc",
        prompt: "first",
        cwd: "/work",
        abortController: new AbortController(),
        onInputReady: (input) => {
            input.send("second", "2");
        },
        appendMessages: async (messages) => {
            appended.push(...messages);
        },
        findExecutable: () => "/usr/local/bin/claude",
        loadSdk: async () => ({
            query: ({ prompt }) => ({
                close: () => {
                    closed = true;
                },
                async *[Symbol.asyncIterator]() {
                    assert.notEqual(typeof prompt, "string");
                    if (typeof prompt === "string") return;
                    const input = prompt[Symbol.asyncIterator]();
                    await input.next();
                    await input.next();
                    blocked = input.next();
                    try {
                        yield {
                            type: "assistant",
                            message: {
                                id: "a",
                                content: [{ type: "text", text: "combined reply" }],
                            },
                        } as const;
                        yield result({ queued_turn_count: 0 });
                        // A real legacy CLI is idle here, waiting for more input forever.
                        await blocked;
                    } finally {
                        returned = true;
                    }
                },
            }),
        }),
    });
    assert.equal(response.isError, true);
    assert.match(response.resultText, /input delivery is uncertain/);
    assert.match(response.resultText, /Do not automatically resend/);
    assert.match(response.resultText, /combined reply/);
    assert.equal(closed, true);
    assert.equal(returned, true);
    assert.ok(blocked);
    assert.equal((await blocked).done, true);
    assert.match(JSON.stringify(appended), /combined reply/);
});
