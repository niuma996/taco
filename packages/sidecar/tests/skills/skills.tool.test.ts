// Skill tool tests: inline-only/live lookup, description, message rendering, reinjection.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AgentMessage, Skill } from "../../src/runtime/pi/types.ts";
import {
    preloadSkillFrontmatter,
    readSkillFrontmatter,
} from "../../src/skills/skillFrontmatter.ts";
import { createSkillBodyMessage, interpolateArgs } from "../../src/skills/skillMessages.ts";
import type { SkillReinjectorHandle } from "../../src/skills/skillReinjector.ts";
import { buildSkillReinjector } from "../../src/skills/skillReinjector.ts";
import { createSkillTool } from "../../src/skills/skillTool.ts";
import { invokeTool } from "../_helpers/invokeTool.ts";

function writeSkill(dir: string, name: string, frontmatter: string, body: string): string {
    const skillDir = join(dir, name);
    const filePath = join(skillDir, "SKILL.md");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(filePath, `---\n${frontmatter}\n---\n${body}`);
    return filePath;
}

function mkInlineSkill(name: string, filePath: string): Skill {
    return { name, description: `${name} desc`, filePath, content: "body" } as Skill;
}

describe("SkillTool inlineOnly guard", () => {
    const PER_CALL = 1;
    let workDir: string;

    it("frontmatter parser exposes inlineOnly as a boolean", () => {
        workDir = mkdtempSync(join(tmpdir(), "taco-skilltool-"));
        try {
            const fp = writeSkill(
                workDir,
                "fan-out",
                "name: fan-out\nrunAs: inline\ninlineOnly: true",
                "# body",
            );
            const fm = readSkillFrontmatter(fp);
            assert.equal(fm.runAs, "inline");
            assert.equal(fm.inlineOnly, true);
        } finally {
            rmSync(workDir, { recursive: true, force: true });
        }
    });

    it("rejects subagent-mode invocation when inlineOnly is true", async () => {
        workDir = mkdtempSync(join(tmpdir(), "taco-skilltool-"));
        try {
            const fp = writeSkill(
                workDir,
                "fan-out",
                "name: fan-out\nrunAs: subagent\ninlineOnly: true",
                "# body",
            );
            const skill = mkInlineSkill("fan-out", fp);
            preloadSkillFrontmatter([skill]);

            let spawnCalled = false;
            const tool = createSkillTool(() => [skill], {
                parentSessionId: "sess-1",
                getReinjector: () => undefined as unknown as SkillReinjectorHandle,
                spawnSkillSubagent: async () => {
                    spawnCalled = true;
                    return { subSessionId: "", resultText: "", isError: false };
                },
            });

            const res = await invokeTool(tool, { skill: "fan-out" }, undefined);

            assert.equal(
                spawnCalled,
                false,
                "spawnSkillSubagent must NOT be called for an inlineOnly skill in subagent mode",
            );
            const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
            assert.ok(text.includes("inline-only"), "tool result must explain inline-only");
            assert.ok(
                text.includes("fan-out"),
                "tool result must name the skill so the model can correct the call",
            );
            assert.deepEqual(res.details, {
                skillName: "fan-out",
                found: true,
                runAs: "subagent",
            });
        } finally {
            rmSync(workDir, { recursive: true, force: true });
        }
    });

    it("allows inline-mode invocation when inlineOnly is true", async () => {
        // The guard only fires when runAs === "subagent". With runAs === "inline"
        // (the default), the skill proceeds through the normal inline reinject
        // path — that is the whole point of `inlineOnly: true`.
        workDir = mkdtempSync(join(tmpdir(), "taco-skilltool-"));
        try {
            const fp = writeSkill(
                workDir,
                "fan-out",
                "name: fan-out\nrunAs: inline\ninlineOnly: true",
                "# body",
            );
            const skill = mkInlineSkill("fan-out", fp);
            preloadSkillFrontmatter([skill]);

            const enqueued: unknown[] = [];
            const handle: SkillReinjectorHandle = {
                markInvoked: () => undefined,
                enqueueInlineInjection: (m) => enqueued.push(m),
            };
            const tool = createSkillTool(() => [skill], {
                parentSessionId: "sess-1",
                getReinjector: () => handle,
            });

            const res = await invokeTool(tool, { skill: "fan-out" }, undefined);
            const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
            assert.ok(text.includes("activated"), "inline path should report activation");
            assert.equal(enqueued.length, 1, "skill body must be enqueued for inline injection");
            assert.deepEqual(res.details, {
                skillName: "fan-out",
                found: true,
                runAs: "inline",
            });
            // PER_CALL is a no-op reference to silence unused-binding linters in
            // some configs.
            void PER_CALL;
        } finally {
            rmSync(workDir, { recursive: true, force: true });
        }
    });
});

function mkLiveSkill(name: string): Skill {
    return {
        name,
        description: `${name} desc`,
        filePath: `/tmp/${name}/SKILL.md`,
        content: `# ${name}`,
    };
}

describe("createSkillTool live lookup", () => {
    it("re-reads getSkills() on every execute() call — later calls see a mutated backing list", async () => {
        let backing: Skill[] = [mkLiveSkill("alpha")];
        const tool = createSkillTool(() => backing, {
            parentSessionId: "sess-1",
            getReinjector: () => undefined,
        });

        const first = await invokeTool(tool, { skill: "beta" }, undefined, { toolCallId: "tc-1" });
        assert.equal(first.details?.found, false, "beta should not resolve before the swap");

        // Simulate SessionRegistry.updateSkills swapping in a fresh scan —
        // no new tool is constructed, just the array the getter closes over.
        backing = [mkLiveSkill("beta")];

        const second = await invokeTool(tool, { skill: "beta" }, undefined, { toolCallId: "tc-2" });
        assert.equal(second.details?.found, true, "beta should resolve after the swap");

        const third = await invokeTool(tool, { skill: "alpha" }, undefined, { toolCallId: "tc-3" });
        assert.equal(third.details?.found, false, "alpha should no longer resolve after the swap");
    });
});

const NO_SKILLS: Skill[] = [];
const getNoSkills = (): Skill[] => NO_SKILLS;
const baseOptions = {
    parentSessionId: "sess-1",
    getReinjector: () => undefined,
};

describe("createSkillTool description", () => {
    it("omits the guidance block when skillAuthoringGuidance is undefined", () => {
        const tool = createSkillTool(getNoSkills, baseOptions);
        assert.ok(!tool.description.includes("<skill_authoring>"));
    });

    it("omits the guidance block when skillAuthoringGuidance is an empty string", () => {
        const tool = createSkillTool(getNoSkills, { ...baseOptions, skillAuthoringGuidance: "" });
        assert.ok(!tool.description.includes("<skill_authoring>"));
    });

    it("appends the guidance block verbatim when provided", () => {
        const guidance = "<skill_authoring>\nput it in /tmp/skills\n</skill_authoring>";
        const tool = createSkillTool(getNoSkills, {
            ...baseOptions,
            skillAuthoringGuidance: guidance,
        });
        assert.ok(tool.description.includes(guidance));
        assert.ok(tool.description.includes("Invoke a skill"), "base description still present");
    });
});

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
    it('wraps the body in <skill_body name="…"> and interpolates args', () => {
        const msg = createSkillBodyMessage({ name: "demo", content: "say $ARGUMENTS" }, "hi");
        assert.equal(msg.role, "user");
        assert.equal(
            (msg as SkillBodyMessage).content,
            '<skill_body name="demo">\nsay hi\n</skill_body>',
        );
    });

    it("appends legacy 'Arguments: ...' when body has no placeholder", () => {
        const msg = createSkillBodyMessage(
            { name: "demo", content: "no placeholder here" },
            "the args",
        );
        assert.equal(
            (msg as SkillBodyMessage).content,
            '<skill_body name="demo">\nno placeholder here\n\nArguments: the args\n</skill_body>',
        );
    });

    it("does not append when args is empty", () => {
        const msg = createSkillBodyMessage({ name: "demo", content: "no placeholder here" }, "");
        assert.equal(
            (msg as SkillBodyMessage).content,
            '<skill_body name="demo">\nno placeholder here\n</skill_body>',
        );
    });
});

function mkReinjectSkill(name: string): Skill {
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
        const { hook, handle } = buildSkillReinjector({ skills: [mkReinjectSkill("demo")] });
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
        const { hook, handle } = buildSkillReinjector({ skills: [mkReinjectSkill("demo")] });
        handle.markInvoked("demo");

        const messages: AgentMessage[] = [
            { role: "user", content: "please continue", timestamp: Date.now() } as AgentMessage,
        ];
        const result = hook({ messages });

        const hasBody = result.messages.some((m) => {
            const c = (m as { content?: unknown }).content;
            return typeof c === "string" && c.includes('<skill_body name="demo">');
        });
        assert.ok(hasBody, "skill body should be reinjected before the last user message");
    });

    it("is a no-op when no skill was invoked and nothing is pending", () => {
        const { hook } = buildSkillReinjector({ skills: [mkReinjectSkill("demo")] });
        const messages: AgentMessage[] = [mkErrorMessage()];
        const result = hook({ messages });
        assert.equal(result.messages, messages, "should return the same array reference");
    });
});
