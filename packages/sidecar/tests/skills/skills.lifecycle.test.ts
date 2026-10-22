// Skill lifecycle tests: diagnostics, dedupe, and create-skill contract.

import { strict as assert } from "node:assert";
import assertStrict from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { Skill } from "../../src/runtime/pi/types.ts";
import type { SkillNameCollision } from "../../src/skills/dedupeSkills.ts";
import {
    dedupeSkillsByName,
    dedupeSkillsByNameWithDuplicates,
} from "../../src/skills/dedupeSkills.ts";
import {
    checkSkillFrontmatter,
    formatSkillDiagnosticMessage,
    type LoaderSkillDiagnostic,
    logSkillDiagnostics,
    mapDuplicateDiagnostics,
    mapLoaderDiagnostics,
    type SkillDiagnosticLogger,
} from "../../src/skills/skillDiagnostics.ts";
import type { SkillFrontmatter } from "../../src/skills/skillFrontmatter.ts";
import {
    parseYamlFrontmatter,
    preloadSkillFrontmatter,
    readSkillFrontmatter,
} from "../../src/skills/skillFrontmatter.ts";
import type { TacoSkill } from "../../src/skills/tacoSkill.ts";

describe("mapLoaderDiagnostics", () => {
    it("passes through every known pi code verbatim", () => {
        const input: LoaderSkillDiagnostic[] = [
            { code: "file_info_failed", message: "stat failed", path: "/a", source: "user" },
            { code: "list_failed", message: "readdir failed", path: "/b", source: "user" },
            { code: "read_failed", message: "EACCES", path: "/c", source: "builtin" },
            { code: "parse_failed", message: "bad yaml", path: "/d", source: "user" },
            { code: "invalid_metadata", message: "no name", path: "/e", source: "user" },
        ];
        const out = mapLoaderDiagnostics(input);

        assert.deepEqual(
            out.map((d) => d.code),
            ["file_info_failed", "list_failed", "read_failed", "parse_failed", "invalid_metadata"],
        );
        // Messages must not be rewritten for known codes.
        assert.deepEqual(
            out.map((d) => d.message),
            ["stat failed", "readdir failed", "EACCES", "bad yaml", "no name"],
        );
        assert.deepEqual(
            out.map((d) => d.source),
            ["user", "user", "builtin", "user", "user"],
        );
    });

    it("omits source when the loader did not supply one", () => {
        const [entry] = mapLoaderDiagnostics([{ code: "read_failed", message: "x", path: "/a" }]);
        assert.ok(!("source" in entry), "source key should be absent, not undefined");
    });

    // pi-side unknown codes are no longer reachable: LoaderSkillDiagnostic.code
    // is the SkillDiagnosticCode union, so out-of-band values fail at compile
    // time. Tests below exercise the in-union codes instead.

    it("maps an empty list to an empty list", () => {
        assert.deepEqual(mapLoaderDiagnostics([]), []);
    });
});

describe("mapDuplicateDiagnostics", () => {
    const collision: SkillNameCollision<{ name: string; filePath: string }> = {
        name: "deep-review",
        dropped: { name: "deep-review", filePath: "/app/builtin/deep-review/SKILL.md" },
        keptFrom: { name: "deep-review", filePath: "/work/.taco/skills/deep-review/SKILL.md" },
    };

    it("reports duplicate_name with the loser as `path` and the winner as `shadowedBy`", () => {
        const [entry] = mapDuplicateDiagnostics([collision]);
        assert.equal(entry.code, "duplicate_name");
        // `path` must be the discarded file: that is the one the user has to
        // rename or delete to resolve the collision.
        assert.equal(entry.path, "/app/builtin/deep-review/SKILL.md");
        assert.equal(entry.shadowedBy, "/work/.taco/skills/deep-review/SKILL.md");
        assert.equal(entry.skillName, "deep-review");
    });

    it("names both files in the message so the collision is actionable without extra lookups", () => {
        const [entry] = mapDuplicateDiagnostics([collision]);
        assert.ok(entry.message.includes("deep-review"));
        assert.ok(entry.message.includes("/work/.taco/skills/deep-review/SKILL.md"));
    });

    it("maps an empty list to an empty list", () => {
        assert.deepEqual(mapDuplicateDiagnostics([]), []);
    });
});

describe("checkSkillFrontmatter", () => {
    const PATH = "/work/.taco/skills/x/SKILL.md";
    // The runtime object is raw parsed YAML, so build fixtures as plain objects
    // rather than relying on the (valid-shape) SkillFrontmatter type.
    const codes = (fm: Record<string, unknown>) =>
        checkSkillFrontmatter(fm as SkillFrontmatter, PATH).map((d) => d.code);

    it("returns nothing for a clean frontmatter", () => {
        assert.deepEqual(codes({ runAs: "inline", inlineOnly: true }), []);
        assert.deepEqual(codes({ runAs: "subagent", allowedTools: ["read"] }), []);
        assert.deepEqual(codes({}), []);
    });

    it("flags an unknown runAs value", () => {
        const [entry] = checkSkillFrontmatter(
            { runAs: "parallel" } as unknown as SkillFrontmatter,
            PATH,
        );
        assert.equal(entry.code, "unknown_run_as");
        assert.equal(entry.path, PATH);
        assert.ok(entry.message.includes("parallel"));
    });

    it("flags a non-boolean inlineOnly", () => {
        assert.deepEqual(codes({ inlineOnly: "yes" }), ["invalid_inline_only"]);
    });

    it("flags inlineOnly:true combined with runAs:subagent as unrunnable", () => {
        // The contradiction skillTool rejects at call time — the main reason
        // this check exists is to surface it at load instead.
        assert.deepEqual(codes({ runAs: "subagent", inlineOnly: true }), ["inline_only_conflict"]);
    });

    it("allows inlineOnly:true with runAs:inline", () => {
        assert.deepEqual(codes({ runAs: "inline", inlineOnly: true }), []);
    });

    it("flags a non-array allowedTools", () => {
        assert.deepEqual(codes({ allowedTools: "read" }), ["invalid_allowed_tools"]);
    });

    it("flags an empty allowedTools list", () => {
        const [entry] = checkSkillFrontmatter({ allowedTools: [] }, PATH);
        assert.equal(entry.code, "empty_allowed_tools");
    });

    // Regression: raw YAML turns `whenToUse:` (empty value) into null and an
    // unquoted number/boolean into a non-string. The stamping loop in
    // server.ts used to call `.trim()` on it, throwing and aborting the whole
    // load; both shapes must degrade to a diagnostic instead.
    it("flags a non-string whenToUse (null from an empty YAML value)", () => {
        assert.deepEqual(codes({ whenToUse: null }), ["invalid_when_to_use"]);
    });

    it("flags a non-string whenToUse (number)", () => {
        assert.deepEqual(codes({ whenToUse: 123 }), ["invalid_when_to_use"]);
    });

    it("accepts a string whenToUse", () => {
        assert.deepEqual(codes({ whenToUse: "pick me when reviewing" }), []);
    });

    it("reports several problems at once rather than stopping at the first", () => {
        assert.deepEqual(codes({ runAs: "bogus", allowedTools: "nope" }), [
            "unknown_run_as",
            "invalid_allowed_tools",
        ]);
    });
});

/** In-memory spy for SkillDiagnosticLogger — captures every call. */
function makeSpyLogger(): SkillDiagnosticLogger & {
    infoCalls: string[];
    warnCalls: string[];
} {
    const infoCalls: string[] = [];
    const warnCalls: string[] = [];
    return {
        info(msg) {
            infoCalls.push(msg);
        },
        warn(msg) {
            warnCalls.push(msg);
        },
        infoCalls,
        warnCalls,
    };
}

describe("logSkillDiagnostics", () => {
    it("emits every diagnostic through `info` and never through `warn`", () => {
        const logger = makeSpyLogger();
        // One of each kind — loader, frontmatter, and a duplicate collision
        // — to make sure the level contract holds for all three sources.
        logSkillDiagnostics(
            {
                loader: mapLoaderDiagnostics([
                    {
                        code: "invalid_metadata",
                        message: "description exceeds 1024 characters (1816)",
                        path: "/Users/lewiiszhang/.claude/skills/zht-dt-cli/SKILL.md",
                        source: "user",
                    },
                    {
                        code: "read_failed",
                        message: "EACCES",
                        path: "/work/.taco/skills/private/SKILL.md",
                    },
                ]),
                frontmatter: checkSkillFrontmatter(
                    { runAs: "parallel" } as unknown as SkillFrontmatter,
                    "/work/.taco/skills/bad-run-as/SKILL.md",
                ),
                duplicates: mapDuplicateDiagnostics([
                    {
                        name: "officecli",
                        dropped: { name: "officecli", filePath: "/builtin/officecli/SKILL.md" },
                        keptFrom: {
                            name: "officecli",
                            filePath: "/work/.taco/skills/officecli/SKILL.md",
                        },
                    } satisfies SkillNameCollision<{ name: string; filePath: string }>,
                ]),
            },
            logger,
        );

        assert.deepEqual(
            logger.warnCalls,
            [],
            "warn must never be called for skill diagnostics — the desktop forwards [warn] lines to a toast on every boot",
        );
        assert.equal(logger.infoCalls.length, 4, "one info line per diagnostic");
        assert.ok(logger.infoCalls.some((m) => m.includes("invalid_metadata")));
        assert.ok(logger.infoCalls.some((m) => m.includes("read_failed")));
        assert.ok(logger.infoCalls.some((m) => m.includes("unknown_run_as")));
        assert.ok(
            logger.infoCalls.some((m) => m.includes("duplicate_name") && m.includes("officecli")),
        );
    });

    it("emits nothing when no diagnostics were produced", () => {
        const logger = makeSpyLogger();
        logSkillDiagnostics({ loader: [], frontmatter: [], duplicates: [] }, logger);
        assert.deepEqual(logger.infoCalls, []);
        assert.deepEqual(logger.warnCalls, []);
    });
});

describe("formatSkillDiagnosticMessage", () => {
    it("renders a stable single-line shape: code + path + message", () => {
        const line = formatSkillDiagnosticMessage({
            code: "parse_failed",
            message: "unexpected token",
            path: "/work/x/SKILL.md",
        });
        // Pinned byte-for-byte so any change is deliberate. Changing the
        // shape silently breaks log parsers downstream that grep on it.
        assert.equal(line, "skill parse_failed at /work/x/SKILL.md: unexpected token");
    });
});

interface Fixture {
    name: string;
    filePath: string;
    source: "builtin" | "user";
}

const userSkill = (name: string, dir = "/work/.taco/skills"): Fixture => ({
    name,
    filePath: `${dir}/${name}/SKILL.md`,
    source: "user",
});

const builtinSkill = (name: string): Fixture => ({
    name,
    filePath: `/app/skills/builtin/${name}/SKILL.md`,
    source: "builtin",
});

const mkSkill = (name: string, origin: string): TacoSkill => ({
    name,
    description: `${name} from ${origin}`,
    filePath: `/fake/${origin}/${name}/SKILL.md`,
    content: `${name} content`,
    source: origin === "builtin" ? "builtin" : "user",
});

describe("dedupeSkillsByName", () => {
    it("returns empty array for empty input", () => {
        assert.deepEqual(dedupeSkillsByName([]), []);
    });

    it("keeps all skills when names are unique", () => {
        const input = [mkSkill("a", "x"), mkSkill("b", "x")];
        const out = dedupeSkillsByName(input);
        assert.equal(out.length, 2);
        assert.deepEqual(
            out.map((s) => s.name),
            ["a", "b"],
        );
    });

    it("keeps first occurrence on duplicate name (first-wins)", () => {
        const input = [mkSkill("foo", "taco"), mkSkill("foo", "claude"), mkSkill("foo", "pi")];
        const out = dedupeSkillsByName(input);
        assert.equal(out.length, 1);
        assert.equal(out[0].description, "foo from taco"); // first-wins
    });

    it("preserves the source field of the winning skill on duplicate name", () => {
        // user skill listed before builtin (defaultSkillDirs semantics), first-wins preserves user.
        const input = [mkSkill("foo", "user-dir"), mkSkill("foo", "builtin")];
        const out = dedupeSkillsByName(input);
        assert.equal(out.length, 1);
        assert.equal(out[0].source, "user");
    });

    it("does not mutate input", () => {
        const input = [mkSkill("a", "x"), mkSkill("a", "y")];
        const inputLen = input.length;
        dedupeSkillsByName(input);
        assert.equal(input.length, inputLen);
    });
});

describe("dedupeSkillsByNameWithDuplicates", () => {
    it("reports a builtin shadowed by a user skill, keeping the user one", () => {
        // defaultSkillDirs order: user dirs first, builtin last.
        const { kept, duplicates } = dedupeSkillsByNameWithDuplicates([
            userSkill("deep-review"),
            builtinSkill("deep-review"),
        ]);

        assertStrict.equal(kept.length, 1);
        assertStrict.equal(kept[0].source, "user", "user skill must win");
        assertStrict.equal(duplicates.length, 1);
        assertStrict.equal(duplicates[0].name, "deep-review");
        assertStrict.equal(duplicates[0].dropped.source, "builtin");
        assertStrict.equal(duplicates[0].keptFrom.source, "user");
    });

    it("reports a collision between two user dirs", () => {
        const first = userSkill("shared", "/work/.taco/skills");
        const second = userSkill("shared", "/home/me/.claude/skills");
        const { kept, duplicates } = dedupeSkillsByNameWithDuplicates([first, second]);

        assertStrict.equal(kept.length, 1);
        assertStrict.equal(kept[0].filePath, first.filePath);
        assertStrict.equal(duplicates.length, 1);
        assertStrict.equal(duplicates[0].dropped.filePath, second.filePath);
        assertStrict.equal(duplicates[0].keptFrom.filePath, first.filePath);
    });

    it("reports every loser when one name appears three times", () => {
        const { kept, duplicates } = dedupeSkillsByNameWithDuplicates([
            userSkill("triple", "/a"),
            userSkill("triple", "/b"),
            userSkill("triple", "/c"),
        ]);

        assertStrict.equal(kept.length, 1);
        assertStrict.equal(duplicates.length, 2);
        // Both losers point at the same winner, not at each other — otherwise a
        // UI would tell the user to look at a file that was itself discarded.
        assertStrict.deepEqual(
            duplicates.map((d) => d.keptFrom.filePath),
            ["/a/triple/SKILL.md", "/a/triple/SKILL.md"],
        );
    });

    it("returns an empty duplicates array when all names are unique", () => {
        const { kept, duplicates } = dedupeSkillsByNameWithDuplicates([
            userSkill("alpha"),
            userSkill("beta"),
        ]);
        assertStrict.equal(kept.length, 2);
        assertStrict.deepEqual(duplicates, []);
    });

    it("handles an empty input", () => {
        const { kept, duplicates } = dedupeSkillsByNameWithDuplicates([]);
        assertStrict.deepEqual(kept, []);
        assertStrict.deepEqual(duplicates, []);
    });
});

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = join(HERE, "..", "..", "src", "skills", "builtin", "create-skill", "SKILL.md");

function body(): string {
    return readFileSync(SKILL_PATH, "utf-8");
}

describe("create-skill builtin skill", () => {
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
        // If taco-private keys get added here, this test will surface them —
        // the meta-skill should use defaults, not override them.
        assert.equal(fm.runAs, undefined);
        assert.equal(fm.inlineOnly, undefined);
        assert.equal(fm.allowedTools, undefined);
        assert.equal(fm.model, undefined);
    });

    it("stays within a workable size band — substantive but not superpowers-verbose", () => {
        // Lower bound guards against the body being trimmed back into a
        // checklist that teaches nothing about scripts; upper bound guards
        // against it growing into a 26k treatise.
        const words = body().split(/\s+/).filter(Boolean).length;
        assert.ok(words > 400, `expected >400 words (substantive), got ${words}`);
        assert.ok(words < 1100, `expected <1100 words (still lean), got ${words}`);
    });
});
