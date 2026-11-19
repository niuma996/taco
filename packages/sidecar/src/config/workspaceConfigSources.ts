import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { resourceRoot } from "../runtime/runtimeResources.ts";
import { tacoHome } from "./tacoHome.ts";

/** Scan input annotated with the provenance stamped onto each loaded skill. */
export interface SkillDirInput {
    path: string;
    source: "builtin" | "user";
    /** Explicit configuration layer; compatibility search roots omit this. */
    scope?: "workspace" | "global";
}

export interface WorkspaceConfigSources {
    skillDirs: SkillDirInput[];
    agentDirs: string[];
    instructionDirs: ReadonlyArray<{
        dir: string;
        label: "project-taco" | "project" | "user-taco" | "user-claude";
    }>;
}

/** Skills and instructions are first-wins; agents override earlier entries. */
export function resolveWorkspaceConfigSources(
    cwd: string,
    projectRoot: string = cwd,
): WorkspaceConfigSources {
    // pi's relativeEnvPath compares against forward slashes even on Windows.
    const fwd = (path: string) => path.replace(/\\/g, "/");
    const home = homedir();
    const userTaco = tacoHome();
    return {
        skillDirs: [
            { path: fwd(resolvePath(cwd, ".taco", "skills")), source: "user", scope: "workspace" },
            ...(resolvePath(projectRoot) === resolvePath(cwd)
                ? []
                : [
                      {
                          path: fwd(resolvePath(projectRoot, ".taco", "skills")),
                          source: "user" as const,
                          scope: "workspace" as const,
                      },
                  ]),
            { path: fwd(resolvePath(userTaco, "skills")), source: "user", scope: "global" },
            { path: fwd(resolvePath(home, ".claude", "skills")), source: "user" },
            { path: fwd(resolvePath(home, ".pi", "skills")), source: "user" },
            { path: fwd(resolvePath(resourceRoot(), "skills", "builtin")), source: "builtin" },
        ],
        agentDirs: [
            resolvePath(home, ".claude", "agents"),
            resolvePath(home, ".pi", "agents"),
            resolvePath(userTaco, "agents"),
            ...(resolvePath(projectRoot) === resolvePath(cwd)
                ? []
                : [resolvePath(projectRoot, ".taco", "agents")]),
            resolvePath(cwd, ".taco", "agents"),
        ],
        instructionDirs: [
            { dir: resolvePath(cwd, ".taco"), label: "project-taco" },
            { dir: cwd, label: "project" },
            ...(resolvePath(projectRoot) === resolvePath(cwd)
                ? []
                : [
                      { dir: resolvePath(projectRoot, ".taco"), label: "project-taco" as const },
                      { dir: projectRoot, label: "project" as const },
                  ]),
            { dir: userTaco, label: "user-taco" },
            { dir: resolvePath(home, ".claude"), label: "user-claude" },
        ],
    };
}
