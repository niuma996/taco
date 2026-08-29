/**
 * create-skill builtin skill — static load test.
 *
 * The body teaches the runtime's own skill-creation loop, so the test's job
 * is to guard that the body stays in sync with the infrastructure it points
 * at: the path guidance, hot-reload behavior, and skills.list diagnostics. If
 * any of those drift (e.g., we add or rename a frontmatter key, or change the
 * reload trigger), the skill starts teaching something false.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { Skill } from "@earendil-works/pi-agent-core";
import {
    parseYamlFrontmatter,
    preloadSkillFrontmatter,
    readSkillFrontmatter,
} from "../../src/skills/skillFrontmatter.ts";
import { createShellTool } from "../../src/tools/shellTool.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = join(HERE, "..", "..", "src", "skills", "builtin", "create-skill", "SKILL.md");

function body(): string {
    return readFileSync(SKILL_PATH, "utf-8");
}

describe("create-skill builtin skill", () => {
    it("exists on disk at the canonical builtin path", () => {
        assert.ok(body().length > 0, "SKILL.md must not be empty");
    });

    it("frontmatter declares name + description, no runAs (default inline)", () => {
        const fm = parseYamlFrontmatter(body());
        assert.equal(fm.name, "create-skill");
        assert.ok(
            typeof fm.description === "string" && fm.description.length > 0,
            "description must be a non-empty string so the skill surfaces in the prompt",
        );
        assert.ok(
            fm.description.toLowerCase().startsWith("use when"),
            "description must lead with the trigger phrase so the model knows when to reach for it",
        );
        // Length stays under pi's 1024-char ceiling so the loader won't flag it.
        assert.ok(fm.description.length <= 1024, "description must fit pi's ceiling");
        // Default runAs is inline; assert nothing declares otherwise — the
        // skill doesn't dispatch subagents and shouldn't be subagent-only.
        assert.equal(
            fm.runAs,
            undefined,
            "create-skill should not override runAs; default inline is correct",
        );
        assert.equal(
            fm.inlineOnly,
            undefined,
            "create-skill should not be inlineOnly — it doesn't dispatch subagents",
        );
    });

    it("directory name matches the frontmatter name (pi loads SKILL.md under a directory named after the skill)", () => {
        const fm = parseYamlFrontmatter(body());
        const parentDir = SKILL_PATH.split("/").slice(-2, -1)[0];
        assert.equal(parentDir, fm.name, "parent directory must equal frontmatter name");
    });

    it("frontmatter is parseable via the cached readSkillFrontmatter path and uses no taco-private keys", () => {
        const skill: Skill = {
            name: "create-skill",
            description: "stub",
            filePath: SKILL_PATH,
            content: "stub",
        } as Skill;
        preloadSkillFrontmatter([skill]);
        const fm = readSkillFrontmatter(SKILL_PATH);
        // checkSkillFrontmatter on this body must produce zero diagnostics.
        // If taco-private keys get added here, this test will surface them
        // — the meta-skill should use defaults, not override them.
        assert.equal(fm.runAs, undefined);
        assert.equal(fm.inlineOnly, undefined);
        assert.equal(fm.allowedTools, undefined);
        assert.equal(fm.model, undefined);
    });

    it("body teaches the trigger-vs-body distinction so descriptions don't summarize the workflow", () => {
        const md = body();
        assert.ok(
            /description.*always.*context/i.test(md),
            "must explain the description is the always-in-context trigger",
        );
        assert.ok(
            /body.*loaded.*after/i.test(md),
            "must explain the body is loaded only on invocation",
        );
    });

    it("body points the user at the runtime's resolved path guidance, not a hard-coded list", () => {
        // The skill tool's authoring guidance carries the resolved paths;
        // hard-coding them in the body would drift as soon as TACO_HOME
        // changes. The body must defer to the live guidance.
        const md = body();
        assert.ok(
            /skill.*tool.*description/i.test(md),
            "must direct the user to the skill tool's description for resolved paths",
        );
        assert.ok(/\.taco\/skills/.test(md), "must still name the canonical workspace dir");
        assert.ok(/TACO_HOME/.test(md), "must still name the user-wide dir");
    });

    it("body teaches the save → reload → diagnostics loop end to end", () => {
        const md = body();
        assert.ok(/save/i.test(md), "must mention saving the file");
        assert.ok(
            /(automatic|reload|watch)/i.test(md),
            "must mention hot-reload so the user doesn't expect a restart",
        );
        assert.ok(/skills\.list/i.test(md), "must point at skills.list as the diagnostics surface");
        assert.ok(
            /diagnostic/i.test(md),
            "must say the word diagnostics so the user knows what to look for",
        );
        // The model cannot call skills.list itself (it is an RPC, not a tool), so
        // the body must not instruct "you" to check it as if the model could —
        // that would be a dead instruction. It should name who actually sees it.
        assert.ok(
            /skills pane|sidecar log|user sees/i.test(md),
            "must name a reachable consumer (skills pane or sidecar log), not assume the model can call skills.list",
        );
    });

    it("body states the real load-drop rule: name mismatch warns, empty description drops", () => {
        // pi's loadSkillFromFile: a name/dir mismatch only yields an
        // invalid_metadata warning (validateName), while a missing/empty
        // description is the sole `return { skill: null }` path. The body once
        // claimed a mismatch drops the skill — that was false. Guard the truth.
        const md = body();
        assert.ok(
            !/must equal `?name`?[^.]*dropped/i.test(md),
            "must not claim a name/dir mismatch drops the skill — it only warns",
        );
        assert.ok(
            /description/i.test(md) && /drop/i.test(md),
            "must name empty description as what actually drops a skill",
        );
    });

    it("body teaches the supporting-file layout that the loader actually permits", () => {
        // loadSkillsFromDirInternal returns as soon as it finds a SKILL.md in a
        // directory, so sibling dirs like scripts/ and references/ are never
        // scanned as skills. The body promises this; if the loader ever starts
        // descending, the promise becomes false and authors get phantom skills.
        const md = body();
        assert.ok(/scripts\//.test(md), "must show a scripts/ directory in the layout");
        assert.ok(/references\//.test(md), "must show a references/ directory in the layout");
        assert.ok(
            /only\s+`?SKILL\.md`?\s+is\s+special|never\s+mistaken\s+for\s+skills/i.test(md),
            "must state that non-SKILL.md files are not loaded as skills",
        );
        assert.ok(
            /relative\s+path/i.test(md),
            "must tell the author to reference supporting files by relative path",
        );
    });

    it("body names the real tool that runs scripts, and the allowedTools filter trap", () => {
        // Bound to the actual tool name rather than a hardcoded string: if the
        // shell tool is ever renamed, this trips instead of the skill silently
        // teaching a tool that no longer exists.
        const shellToolName = createShellTool().name;
        const md = body();
        assert.ok(
            md.includes(`\`${shellToolName}\``),
            `must name the ${shellToolName} tool as how scripts execute`,
        );
        // agentSpawner builds `new Set(allowedTools)` and filters the toolset,
        // so an allowedTools list that omits shell makes scripts unrunnable.
        assert.ok(
            /allowedTools/.test(md) && /filter/i.test(md),
            "must warn that allowedTools is a filter which can strip the shell tool",
        );
    });

    it("body documents the inline vs subagent asymmetry that breaks script-bearing skills", () => {
        // spawnSkillSubagent strips the `skill` tool from childTools and starts
        // a fresh session, so a subagent skill has neither conversation context
        // nor the ability to invoke skills. Authors must know before choosing.
        const md = body();
        assert.ok(/runAs:\s*subagent/.test(md), "must name the runAs: subagent option");
        assert.ok(
            /inlineOnly/.test(md),
            "must explain inlineOnly for skills that only make sense inline",
        );
        assert.ok(
            /no\s+conversation\s+context|cannot\s+invoke\s+skills/i.test(md),
            "must state what a subagent skill loses",
        );
    });

    it("body tells the author to run scripts end to end before trusting the skill", () => {
        const md = body();
        assert.ok(
            /interpreter|python3/i.test(md),
            "must tell the author to name the interpreter in the command",
        );
        assert.ok(/output/i.test(md), "must tell the author to document the script's output shape");
    });

    it("body keeps taco-private frontmatter practical, not a schema dump", () => {
        // The keys must appear in the context that makes them actionable
        // (which to pick, what breaks) rather than as a reference table —
        // the runtime's own guidance is the schema's home.
        const md = body();
        assert.ok(
            /runAs/.test(md) && /inlineOnly/.test(md) && /allowedTools/.test(md),
            "must name the taco-private keys an author actually has to decide on",
        );
        const tableRows = md.split("\n").filter((l) => /^\s*\|\s/.test(l)).length;
        assert.ok(
            tableRows === 0,
            `must not degenerate into a frontmatter reference table (found ${tableRows} rows)`,
        );
    });

    it("body shows a contrasting description example, since that is the top failure mode", () => {
        // A loaded-but-never-triggered skill is the most common outcome, and
        // it is always a description problem. Prose alone doesn't land it.
        const md = body();
        assert.ok(
            /bad\b/i.test(md) && /good\b/i.test(md),
            "must contrast a bad and a good description",
        );
        assert.ok(
            /doesn't fire|never (reaches|fires)|not (firing|triggering)/i.test(md),
            "must have a section for the loaded-but-not-triggering case",
        );
    });

    it("body stays within a workable size band — substantive but not superpowers-verbose", () => {
        // Lower bound guards against the body being trimmed back into a
        // checklist that teaches nothing about scripts; upper bound guards
        // against it growing into a 26k treatise.
        const words = body().split(/\s+/).filter(Boolean).length;
        assert.ok(words > 400, `expected >400 words (substantive), got ${words}`);
        assert.ok(words < 1100, `expected <1100 words (still lean), got ${words}`);
    });
});
