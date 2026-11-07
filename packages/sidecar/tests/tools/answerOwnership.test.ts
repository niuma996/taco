import assert from "node:assert/strict";
import { it } from "node:test";
import type { AttachedSession } from "../../src/runtime/harness/attachedSession.ts";
import { resolveAskUserQuestions } from "../../src/tools/askUserInjectionText.ts";

const pending = {
    type: "message",
    message: {
        role: "toolResult",
        toolName: "askUser",
        toolCallId: "q",
        details: { waiting: true, questions: [{ question: "Choose?" }] },
    },
};
const attached = (entries: unknown[]) =>
    ({
        session: { branch: async () => ({ findEntries: async () => entries }) },
    }) as unknown as AttachedSession;

it("rejects a stale question after an answer was admitted", async () => {
    assert.equal(
        await resolveAskUserQuestions(
            attached([
                pending,
                { type: "message", message: { role: "user", content: "answered" } },
            ]),
            "q",
            "askUser",
        ),
        null,
    );
});
it("rejects an older question when another interaction is pending", async () => {
    const newer = { ...pending, message: { ...pending.message, toolCallId: "q-next" } };
    assert.equal(await resolveAskUserQuestions(attached([pending, newer]), "q", "askUser"), null);
});
it("keeps the currently unanswered question actionable", async () => {
    assert.deepEqual(await resolveAskUserQuestions(attached([pending]), "q", "askUser"), [
        { question: "Choose?" },
    ]);
});
