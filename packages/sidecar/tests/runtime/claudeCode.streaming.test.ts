import assert from "node:assert/strict";
import { it } from "node:test";
import { asSessionId } from "@taco-ai/protocol";
import type { AgentMessage } from "../../src/runtime/pi/types.ts";
import {
    type ClaudeCodeInputHandle,
    type RunClaudeCodeSubagentArgs,
    runClaudeCodeSubagent,
} from "../../src/runtime/subagent/claudeCode/claudeCodeRunner.ts";
import type {
    ClaudeAgentSdk,
    SdkMessage,
} from "../../src/runtime/subagent/claudeCode/claudeCodeSdk.ts";

const initial = { type: "system", subtype: "init", session_id: "native-session" } as const;
const answer = (text: string): SdkMessage => ({
    type: "assistant",
    message: { id: text, content: [{ type: "text", text }] },
});
const result = (fields = {}): SdkMessage => ({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 1,
    ...fields,
});

function args(query: ClaudeAgentSdk["query"]): RunClaudeCodeSubagentArgs {
    return {
        subSessionId: asSessionId("child-stream"),
        agentType: "cc",
        prompt: "first",
        cwd: "/work",
        abortController: new AbortController(),
        appendMessages: async () => {},
        loadSdk: async () => ({ query }),
        findExecutable: () => "/usr/local/bin/claude",
    };
}

it("persists the native ID before publishing a resumable checkpoint and resumes exactly it", async () => {
    const events: string[] = [];
    const run = args(async function* ({ options }) {
        assert.equal(options.persistSession, true);
        assert.equal(options.resume, "requested-session");
        assert.equal("continue" in options, false);
        yield initial;
        assert.deepEqual(events, ["saved", "checkpoint"]);
        yield answer("done");
        yield result();
    });
    const response = await runClaudeCodeSubagent({
        ...run,
        resumeSessionId: "requested-session",
        onSessionId: async (id) => {
            assert.equal(id, "native-session");
            await Promise.resolve();
            events.push("saved");
        },
        onUpdate: (update, checkpoint) => {
            if (!checkpoint) return;
            const text = JSON.stringify(update.content);
            if (text.includes("resume that session with chatToAgent")) {
                assert.deepEqual(events, ["saved"]);
                events.push("checkpoint");
            }
        },
    });
    assert.equal(response.isError, false, response.resultText);
    assert.deepEqual(events, ["saved", "checkpoint"]);
});

it("does not select a recent session for a fresh run and saves a repeated init only once", async () => {
    const saved: string[] = [];
    const response = await runClaudeCodeSubagent({
        ...args(async function* ({ options }) {
            assert.equal("resume" in options, false);
            assert.equal("continue" in options, false);
            yield initial;
            yield initial;
            yield answer("done");
            yield result();
        }),
        onSessionId: async (id) => {
            saved.push(id);
        },
    });
    assert.equal(response.isError, false, response.resultText);
    assert.deepEqual(saved, ["native-session"]);
});

it("fails closed when saving the native ID fails", async () => {
    const checkpoints: string[] = [];
    const response = await runClaudeCodeSubagent({
        ...args(async function* () {
            yield initial;
            yield answer("must not run");
            yield result();
        }),
        onSessionId: async () => {
            throw new Error("session write failed");
        },
        onUpdate: (update, checkpoint) => {
            if (checkpoint) checkpoints.push(JSON.stringify(update.content));
        },
    });
    assert.equal(response.isError, true);
    assert.match(response.resultText, /session write failed/);
    assert.ok(checkpoints.every((text) => !text.includes("resume that session with chatToAgent")));
});

it("offers recovery after a failure only once the native ID was saved", async () => {
    const response = await runClaudeCodeSubagent({
        ...args(async function* () {
            yield initial;
            yield answer("partial");
            throw new Error("offline");
        }),
        onSessionId: async () => {},
    });
    assert.equal(response.isError, true);
    assert.match(response.resultText, /call chatToAgent/);
    assert.match(response.resultText, /partial/);
});

it("registers the first input before readiness, streams runtime sends in order, and closes at the last result", {
    timeout: 1500,
}, async () => {
    let handle: ClaudeCodeInputHandle | undefined;
    const appended: AgentMessage[] = [];
    const response = await runClaudeCodeSubagent({
        ...args(async function* ({ prompt }) {
            assert.notEqual(typeof prompt, "string");
            if (typeof prompt === "string") return;
            const input = prompt[Symbol.asyncIterator]();
            const first = await input.next();
            assert.equal(first.value.message.role, "user");
            assert.equal(first.value.message.content, "first");
            assert.equal(first.value.parent_tool_use_id, null);
            assert.ok(first.value.uuid);
            const second = await input.next();
            assert.equal(second.value.message.content, "second");
            assert.equal(second.value.uuid, "message-2");
            yield initial;
            yield answer("one");
            yield result({ user_message_uuid: first.value.uuid });
            assert.ok(handle?.send("third", "message-3"));
            const third = await input.next();
            assert.equal(third.value.uuid, "message-3");
            yield answer("two");
            yield result({ user_message_uuid: second.value.uuid });
            yield answer("three");
            yield result({ user_message_uuid: third.value.uuid });
            assert.deepEqual(await input.next(), { done: true, value: undefined });
            assert.equal(handle?.send("too late", "late"), false);
        }),
        onInputReady: (ready) => {
            handle = ready;
            assert.equal(ready.send("second", "message-2"), true);
            assert.equal(ready.send("duplicate", "message-2"), false);
        },
        appendMessages: async (messages) => {
            appended.push(...messages);
        },
    });
    assert.equal(response.isError, false, response.resultText);
    assert.equal(response.resultText, "three");
    assert.deepEqual(
        appended.filter((m) => m.role === "user").map((m) => m.content),
        ["first", "second", "third"],
    );
    assert.equal(appended.filter((m) => m.role === "assistant").length, 3);
    assert.equal(handle?.send("after exit", "exit"), false);
});

it("completes coalesced sends from one result instead of waiting for nonexistent extra results", {
    timeout: 1500,
}, async () => {
    const response = await runClaudeCodeSubagent({
        ...args(async function* ({ prompt }) {
            assert.notEqual(typeof prompt, "string");
            if (typeof prompt === "string") return;
            const input = prompt[Symbol.asyncIterator]();
            const first = await input.next();
            const second = await input.next();
            yield answer("batched");
            yield result({ user_message_uuids: [first.value.uuid, second.value.uuid] });
            assert.equal((await input.next()).done, true);
        }),
        onInputReady: (ready) => {
            ready.send("second", "message-2");
        },
    });
    assert.equal(response.isError, false, response.resultText);
});

it("keeps input open for the CLI's queued turns even when known inputs are complete", {
    timeout: 1500,
}, async () => {
    let handle: ClaudeCodeInputHandle | undefined;
    const response = await runClaudeCodeSubagent({
        ...args(async function* ({ prompt }) {
            assert.notEqual(typeof prompt, "string");
            if (typeof prompt === "string") return;
            const input = prompt[Symbol.asyncIterator]();
            await input.next();
            yield answer("one");
            yield result({ queued_turn_count: 1 });
            assert.ok(handle?.send("second", "message-2"));
            await input.next();
            yield answer("two");
            yield result({ user_message_uuid: "message-2", queued_turn_count: 0 });
            assert.equal((await input.next()).done, true);
        }),
        onInputReady: (ready) => {
            handle = ready;
        },
    });
    assert.equal(response.isError, false, response.resultText);
});

for (const end of ["abort", "throw", "end", "close", "callback"] as const) {
    it(`closes input on ${end} and wakes a blocked input reader`, { timeout: 1500 }, async () => {
        let handle: ClaudeCodeInputHandle | undefined;
        let blocked: Promise<IteratorResult<unknown>> | undefined;
        let ended = false;
        const run = args(async function* ({ prompt, options }) {
            assert.notEqual(typeof prompt, "string");
            if (typeof prompt === "string") return;
            const input = prompt[Symbol.asyncIterator]();
            await input.next();
            blocked = input.next();
            try {
                if (end === "abort") {
                    options.abortController.abort({ kind: "subagent-timeout", timeoutMinutes: 2 });
                    assert.equal((await blocked).done, true);
                }
                if (end === "throw") throw new Error("stream failed");
                if (end === "close") {
                    handle?.close();
                    handle?.close();
                }
                if (end === "callback") yield initial;
            } finally {
                ended = true;
            }
        });
        const response = await runClaudeCodeSubagent({
            ...run,
            onInputReady: (ready) => {
                handle = ready;
            },
            onSessionId: async () => {
                throw new Error("save failed");
            },
        });
        assert.ok(ended);
        assert.ok(blocked);
        assert.equal((await blocked).done, true);
        assert.equal(handle?.send("late", "late"), false);
        if (end === "abort") {
            assert.equal(response.aborted, true);
            assert.match(response.resultText, /2-minute time budget/);
        }
    });
}

it("does not hide a streaming exception behind an earlier max-turn result", async () => {
    const response = await runClaudeCodeSubagent(
        args(async function* () {
            yield answer("partial");
            yield result({ subtype: "error_max_turns", is_error: true });
            throw new Error("transport failed");
        }),
    );
    assert.equal(response.isError, true);
    assert.match(response.resultText, /transport failed/);
});

it("does not return an earlier answer when the last successful result has no reply", async () => {
    const response = await runClaudeCodeSubagent(
        args(async function* () {
            yield answer("old reply");
            yield result();
            yield result({ result: "Not logged in" });
        }),
    );
    assert.equal(response.isError, true);
});

it("keeps assistant chunks merged when input arrives during the same reply", async () => {
    let handle: ClaudeCodeInputHandle | undefined;
    const appended: AgentMessage[] = [];
    const response = await runClaudeCodeSubagent({
        ...args(async function* () {
            yield {
                type: "assistant",
                message: { id: "a", content: [{ type: "text", text: "first " }] },
            };
            assert.ok(handle?.send("extra context", "message-2"));
            yield {
                type: "assistant",
                message: { id: "a", content: [{ type: "text", text: "second" }] },
            };
            yield result();
            yield result();
        }),
        onInputReady: (ready) => {
            handle = ready;
        },
        appendMessages: async (messages) => {
            appended.push(...messages);
        },
    });
    const replies = appended.filter((m) => m.role === "assistant");
    assert.equal(replies.length, 1);
    assert.deepEqual(replies[0]?.content, [
        { type: "text", text: "first " },
        { type: "text", text: "second" },
    ]);
    assert.equal(response.isError, true);
});
