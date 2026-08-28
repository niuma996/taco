/**
 * skillDiagnostics — map loader warnings into the wire shape `skills.list`
 * returns.
 *
 * Two independent sources feed this:
 *  - pi-agent-core's `loadSourcedSkills`, which reports per-file failures
 *    (unreadable, unparseable, invalid metadata) and tags each with the search
 *    root it came from.
 *  - taco's own `dedupeSkillsByNameWithDuplicates`, which is the only place a
 *    same-name collision is observable — pi does not dedupe, so it has no
 *    diagnostic for "your skill was shadowed by a higher-priority one".
 *
 * Pure functions, no I/O: `server.ts` does the loading, this file only reshapes,
 * which keeps it unit-testable without standing up a workspace.
 */

import type { SkillDiagnosticEntry } from "@taco-ai/protocol";
import type { SkillNameCollision } from "./dedupeSkills.ts";
import type { SkillFrontmatter } from "./skillFrontmatter.ts";

/**
 * The subset of pi's `SkillDiagnostic & { source }` this mapper needs. Declared
 * structurally rather than imported so a change to pi's optional fields does
 * not break the build here; `code` is intentionally `string` because pi's union
 * is its own and is validated by the switch in `toWireCode`.
 */
export interface LoaderSkillDiagnostic {
    code: string;
    message: string;
    path: string;
    source?: "builtin" | "user";
}

/**
 * Narrow a loader code to the protocol union, falling back to `parse_failed`.
 *
 * pi could add a code in a future version; emitting an unknown string would
 * make `SkillDiagnosticCode` a lie on the wire. `parse_failed` is the honest
 * generic bucket — the original code is preserved in the message so nothing is
 * actually lost.
 */
function toWireCode(code: string): { code: SkillDiagnosticEntry["code"]; unknown: boolean } {
    switch (code) {
        case "file_info_failed":
        case "list_failed":
        case "read_failed":
        case "parse_failed":
        case "invalid_metadata":
            return { code, unknown: false };
        default:
            return { code: "parse_failed", unknown: true };
    }
}

/** Map pi loader diagnostics to wire entries. */
export function mapLoaderDiagnostics(
    diagnostics: ReadonlyArray<LoaderSkillDiagnostic>,
): SkillDiagnosticEntry[] {
    return diagnostics.map((d) => {
        const { code, unknown } = toWireCode(d.code);
        return {
            code,
            // Keep the original code visible when it fell into the fallback
            // bucket, so an unrecognized loader code is still diagnosable.
            message: unknown ? `${d.code}: ${d.message}` : d.message,
            path: d.path,
            ...(d.source !== undefined ? { source: d.source } : {}),
        };
    });
}

/** Map dedupe collisions to `duplicate_name` wire entries. */
export function mapDuplicateDiagnostics<T extends { name: string; filePath: string }>(
    duplicates: ReadonlyArray<SkillNameCollision<T>>,
): SkillDiagnosticEntry[] {
    return duplicates.map((dup) => ({
        code: "duplicate_name" as const,
        message:
            `Skill "${dup.name}" was ignored: another skill with the same name ` +
            `takes priority (${dup.keptFrom.filePath}).`,
        // `path` is the loser — it is the file the user needs to rename or
        // delete, which is the actionable one.
        path: dup.dropped.filePath,
        skillName: dup.name,
        shadowedBy: dup.keptFrom.filePath,
    }));
}

const VALID_RUN_AS = ["inline", "subagent"] as const;

/**
 * Check the taco-private frontmatter keys pi ignores (`runAs`, `inlineOnly`,
 * `allowedTools`) for a skill that already loaded, and emit one diagnostic per
 * problem.
 *
 * pi's loader drops these keys without looking at them, so a malformed value
 * loads cleanly and otherwise only fails when the skill is invoked — catching
 * it here surfaces the mistake on `skills.list` at load / hot-reload time.
 *
 * `frontmatter` is typed as the *valid* shape, but the runtime object is raw
 * parsed YAML, so fields may be the wrong type. Read them as `unknown` and
 * narrow. Deliberately absent: `name` / `description` / YAML errors (pi already
 * reports those via `invalid_metadata` / `parse_failed`) and the
 * `unknown_allowed_tool` cross-check (tool names are not known at load time).
 */
export function checkSkillFrontmatter(
    frontmatter: SkillFrontmatter,
    path: string,
): SkillDiagnosticEntry[] {
    const fm = frontmatter as Record<string, unknown>;
    const out: SkillDiagnosticEntry[] = [];

    const runAs = fm.runAs;
    if (runAs !== undefined && runAs !== "inline" && runAs !== "subagent") {
        out.push({
            code: "unknown_run_as",
            message: `\`runAs\` must be one of ${VALID_RUN_AS.join(" | ")}; got ${JSON.stringify(runAs)}.`,
            path,
        });
    }

    const inlineOnly = fm.inlineOnly;
    if (inlineOnly !== undefined && typeof inlineOnly !== "boolean") {
        out.push({
            code: "invalid_inline_only",
            message: `\`inlineOnly\` must be a boolean; got ${JSON.stringify(inlineOnly)}.`,
            path,
        });
    }

    // The contradiction skillTool rejects at call time: an inlineOnly skill
    // refuses subagent invocation, so this combination can never run.
    if (inlineOnly === true && runAs === "subagent") {
        out.push({
            code: "inline_only_conflict",
            message:
                "`inlineOnly: true` contradicts `runAs: subagent` — an inlineOnly skill refuses subagent invocation, so this skill could never run. Drop one of the two.",
            path,
        });
    }

    const allowedTools = fm.allowedTools;
    if (allowedTools !== undefined && !Array.isArray(allowedTools)) {
        out.push({
            code: "invalid_allowed_tools",
            message: `\`allowedTools\` must be an array of tool names; got ${JSON.stringify(allowedTools)}.`,
            path,
        });
    } else if (Array.isArray(allowedTools) && allowedTools.length === 0) {
        out.push({
            code: "empty_allowed_tools",
            message:
                "`allowedTools` is an empty list, which gives the subagent no tools at all. Omit the key to inherit the default toolset.",
            path,
        });
    }

    return out;
}
