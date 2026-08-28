/**
 * skills.* handler — list skills loaded into the workspace and read
 * their content. Populated by loadSourcedSkills during
 * ensureWorkspace from <cwd>/.taco/skills, $TACO_HOME/skills,
 * ~/.claude/skills, ~/.pi/skills, and built-in skills/builtin
 * (see defaultSkillDirs); each skill is tagged source: "builtin" |
 * "user" (TacoSkill, see tacoSkill.ts). skills.content enforces a
 * filePath whitelist to block path traversal outside the workspace.
 */

import * as nodeFs from "node:fs/promises";
import * as nodePath from "node:path";
import type {
    SkillContentParams,
    SkillContentResult,
    SkillEntry,
    SkillsListParams,
    SkillsListResult,
} from "@taco-ai/protocol";
import { skillContentSchema, skillsListSchema } from "@taco-ai/protocol";
import { RPC } from "@taco-ai/shared";
import { type MethodCtx, registerMethod } from "../methodRegistry.ts";

export function registerSkillsHandlers(): void {
    registerMethod(
        RPC.skillsList,
        true,
        async ({ workspace }: MethodCtx<SkillsListParams>): Promise<SkillsListResult> => {
            const skills = workspace.resources.skills ?? [];
            const entries: SkillEntry[] = skills.map((s) => ({
                name: s.name,
                description: s.description,
                filePath: s.filePath,
                source: s.source,
                disableModelInvocation: s.disableModelInvocation,
                inlineOnly: s.inlineOnly,
            }));
            // Omit the key entirely when there is nothing wrong, rather than
            // sending `diagnostics: []`. Clients written before this field
            // existed then see a byte-identical result in the common case.
            const diagnostics = workspace.skillDiagnostics ?? [];
            return diagnostics.length > 0
                ? { skills: entries, diagnostics: [...diagnostics] }
                : { skills: entries };
        },
        { schema: skillsListSchema },
    );

    registerMethod(
        RPC.skillContent,
        true,
        async ({
            workspace,
            params,
        }: MethodCtx<SkillContentParams>): Promise<SkillContentResult> => {
            const absPath = resolveLoadedSkillPath(workspace, params.filePath, "skill content");
            const content = await nodeFs.readFile(absPath, "utf-8");
            return { content };
        },
        { schema: skillContentSchema },
    );
}

/**
 * Resolve a client-supplied skill path, enforcing that it is one the loader
 * already found.
 *
 * filePath must be in the already-loaded skill list — clients only construct it
 * from values returned by skills.list, but the RPC layer cannot trust the
 * client, so the whitelist blocks arbitrary path reads.
 *
 * Resolve against executionCwd (where skills were actually loaded), not
 * sessionCwd. For an IM workspace with a binding, the two differ, and using the
 * wrong base would silently shadow the loaded root if filePath ever became
 * relative. The whitelist still makes this safe today; using the right base
 * documents the intent.
 *
 * Both sides are compared in forward-slash form so the whitelist holds on
 * Windows regardless of whether the loader stored backslash (native) or
 * forward-slash (normalized via SlashNormalizedExecutionEnv / defaultSkillDirs)
 * separators.
 */
function resolveLoadedSkillPath(
    workspace: MethodCtx<unknown>["workspace"],
    filePath: string,
    what: string,
): string {
    const allowed = new Set((workspace.resources.skills ?? []).map((s) => s.filePath));
    const absPath = nodePath.resolve(workspace.executionCwd, filePath);
    const fwd = (p: string) => p.replace(/\\/g, "/");
    const normalizedAllowed = new Set([...allowed].map(fwd));
    if (!normalizedAllowed.has(fwd(absPath))) {
        throw new Error(`${what} not available: ${filePath}`);
    }
    return absPath;
}
