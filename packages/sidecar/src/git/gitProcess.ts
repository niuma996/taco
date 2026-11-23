import type { BUILTIN_FIXED_GIT_INSPECTIONS } from "@taco-ai/protocol";
import { scrubbedProcessEnv } from "../runtime/models/providerKeyStore.ts";

const inspections = {
    "git --version": ["--version"],
    "git version": ["--version"],
    "git rev-parse HEAD": ["rev-parse", "--verify", "HEAD"],
    "git rev-parse --show-toplevel": ["rev-parse", "--show-toplevel"],
    "git status": ["status"],
    "git status --short": ["status", "--short"],
    "git diff": ["diff", "--no-ext-diff", "--no-textconv", "--no-color"],
    "git diff --cached": ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-color"],
    "git diff --stat": ["diff", "--stat", "--no-ext-diff", "--no-textconv", "--no-color"],
    "git log --oneline": [
        "log",
        "--format=oneline",
        "--abbrev-commit",
        "--no-show-signature",
        "--no-notes",
        "--no-decorate",
        "--no-color",
        "--no-patch",
        "--",
    ],
} satisfies Record<(typeof BUILTIN_FIXED_GIT_INSPECTIONS)[number], readonly string[]>;
const fixedInspections: ReadonlyMap<string, readonly string[]> = new Map(
    Object.entries(inspections),
);

/** Fixed standalone forms only; never forward caller-supplied arguments. */
export function fixedGitInspection(command: string): readonly string[] | undefined {
    return fixedInspections.get(command.replace(/^[ \t]+|[ \t]+$/g, "").replace(/[ \t]+/g, " "));
}

export function gitEnvironment(): Record<string, string> {
    const env = scrubbedProcessEnv();
    for (const key of Object.keys(env)) {
        if (key.toUpperCase().startsWith("GIT_")) Reflect.deleteProperty(env, key);
    }
    return { ...env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
}

export function gitArguments(cwd: string, args: readonly string[]): string[] {
    return ["--no-pager", "-c", "core.fsmonitor=false", "-C", cwd, ...args];
}
