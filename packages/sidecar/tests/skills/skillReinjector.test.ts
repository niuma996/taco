import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { AgentMessage, Skill } from "@earendil-works/pi-agent-core";
import { buildSkillReinjector } from "../../src/skills/skillReinjector.ts";

function mkSkill(name: string): Skill {
    return {
        name,
        description: `${name} desc`,
        filePath: `/fake/${name}/SKILL.md`,
        content: `${name} body`,
    } as Skill;
}

/** A failed-run AgentMessage: role=assistant with stopReason=error carries no
 *  content array in some variants — content may be undefined. */
function mkErrorMessage(): AgentMessage {
    return {
        role: "assistant",
        stopReason: "error",
        errorMessage: "boom",
        timestamp: Date.now(),
    } as unknown as AgentMessage;
}

describe("buildSkillReinjector", () => {
    it("does not throw when a message has no content array after a skill was invoked", () => {
        // Regression: extractText did `content.filter(...)` on a message whose
        // `content` was undefined (e.g. a stopReason=error assistant message),
        // throwing "Cannot read properties of undefined (reading 'filter')".
        // The context hook is protocol-level (no try/catch), so the throw failed
        // the whole prompt and got persisted as an error turn.
        const { hook, handle } = buildSkillReinjector({ skills: [mkSkill("demo")] });
        // Invoking a skill flips invokedSkills.size > 0, so findInjectedSkillNames
        // runs on every message — including the content-less error message.
        handle.markInvoked("demo");

        const messages: AgentMessage[] = [
            { role: "user", content: "hi", timestamp: Date.now() } as AgentMessage,
            mkErrorMessage(),
        ];

        assert.doesNotThrow(() => hook({ messages }));
    });

    it("reinjects an invoked skill whose body was compacted away", () => {
        const { hook, handle } = buildSkillReinjector({ skills: [mkSkill("demo")] });
        handle.markInvoked("demo");

        const messages: AgentMessage[] = [
            { role: "user", content: "please continue", timestamp: Date.now() } as AgentMessage,
        ];
        const result = hook({ messages });

        const hasBody = result.messages.some((m) => {
            const c = (m as { content?: unknown }).content;
            return typeof c === "string" && c.includes("<skill_body:demo>");
        });
        assert.ok(hasBody, "skill body should be reinjected before the last user message");
    });

    it("is a no-op when no skill was invoked and nothing is pending", () => {
        const { hook } = buildSkillReinjector({ skills: [mkSkill("demo")] });
        const messages: AgentMessage[] = [mkErrorMessage()];
        const result = hook({ messages });
        assert.equal(result.messages, messages, "should return the same array reference");
    });
});
