/**
 * The pdf-edit builtin skill: frontmatter, and the tools it names.
 *
 * The skill teaches a workflow, so a tool name it mentions that does not
 * exist would send the model after a tool it cannot call.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseYamlFrontmatter } from "../../src/skills/skillFrontmatter.ts";
import { defaultTools } from "../../src/tools/index.ts";

const DR_HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = join(DR_HERE, "..", "..", "src", "skills", "builtin", "pdf-edit", "SKILL.md");

function body(): string {
    return readFileSync(SKILL_PATH, "utf-8");
}

describe("pdf-edit builtin skill", () => {
    it("declares a name and a description that names the situations it covers", () => {
        const fm = parseYamlFrontmatter(body());
        assert.equal(fm.name, "pdf-edit");
        assert.ok(
            typeof fm.description === "string" && fm.description.length > 0,
            "description must be non-empty so the skill surfaces in the prompt",
        );
        // The description is the trigger: it must name the situations, not
        // summarize the procedure.
        for (const trigger of ["merge", "split", "fill"]) {
            assert.ok(
                fm.description.toLowerCase().includes(trigger),
                `description should mention "${trigger}"`,
            );
        }
    });

    it("names only tools that exist", () => {
        const registered = new Set(defaultTools().map((t) => t.name));
        const mentioned = body().match(/\bpdf[A-Z]\w*/g) ?? [];
        assert.ok(mentioned.length > 0, "the skill should name its tools");
        for (const name of mentioned) {
            assert.ok(registered.has(name), `${name} is not a registered tool`);
        }
    });

    it("tells the model to list the fields before filling them", () => {
        // Filling a field the form does not have fails, so the skill has to
        // make listing the fields the first step of filling one.
        const text = body();
        const filling = text.slice(text.indexOf("## Filling a form"));
        assert.ok(filling.length > 0, "the skill should have a filling section");
        assert.ok(filling.includes("pdfFields"), "the section should point at pdfFields");
        assert.ok(
            filling.indexOf("pdfFields") < filling.indexOf("pdfFill"),
            "listing the fields should come before filling them",
        );
    });
});
