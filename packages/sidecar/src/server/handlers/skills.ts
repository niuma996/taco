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
            return { skills: entries };
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
            // filePath must be in the already-loaded skill list — clients
            // only construct it from values returned by skills.list, but
            // the RPC layer cannot trust the client, so we enforce the
            // whitelist to block arbitrary path reads.
            const allowed = new Set((workspace.resources.skills ?? []).map((s) => s.filePath));
            // Resolve against executionCwd (where skills were actually
            // loaded), not sessionCwd. For an IM workspace with a binding,
            // the two differ, and using the wrong base would silently shadow
            // the loaded root if filePath ever became relative. The whitelist
            // still makes this safe today; using the right base documents the
            // intent.
            const absPath = nodePath.resolve(workspace.executionCwd, params.filePath);
            if (!allowed.has(absPath)) {
                throw new Error(`skill content not available: ${params.filePath}`);
            }
            const content = await nodeFs.readFile(absPath, "utf-8");
            return { content };
        },
        { schema: skillContentSchema },
    );
}
