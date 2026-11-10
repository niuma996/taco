/** Shared runtime and configuration-layer skill scans. */
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { AgentScope, CatalogScope, SkillDiagnosticEntry } from "@taco-ai/protocol";
import { defaultSkillDirs, extensionSkillDirInputs } from "../config/config.ts";
import { tacoHome } from "../config/tacoHome.ts";
import { harnessContext } from "../lib/harnessContext.ts";
import { createLogger } from "../lib/logger.ts";
import { SlashNormalizedExecutionEnv } from "../runtime/harness/slashNormalizedEnv.ts";
import { loadSourcedSkills } from "../runtime/pi/values.ts";
import { dedupeSkillsByNameWithDuplicates } from "./dedupeSkills.ts";
import {
    checkSkillFrontmatter,
    logSkillDiagnostics,
    mapDuplicateDiagnostics,
    mapLoaderDiagnostics,
} from "./skillDiagnostics.ts";
import {
    clearSkillFrontmatterCache,
    parseYamlFrontmatter,
    preloadSkillFrontmatter,
    readSkillFrontmatter,
} from "./skillFrontmatter.ts";
import type { SkillScanResult, TacoSkill } from "./tacoSkill.ts";

/** Classify provenance without altering runtime source priority. */
export function skillScopeOf(
    skill: Pick<TacoSkill, "source" | "filePath">,
    executionCwd: string | undefined,
): AgentScope | undefined {
    if (skill.source === "builtin" || executionCwd === undefined) return undefined;
    const file = resolve(executionCwd, skill.filePath);
    return [".taco", ".pi"].some((dir) => {
        const rel = relative(resolve(executionCwd, dir, "skills"), file);
        return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    })
        ? "workspace"
        : "global";
}

/** Omitted scope preserves runtime aggregation; explicit scopes scan original source definitions. */
export async function loadSkillCatalog(
    fsCwd: string,
    extensionDirs: readonly string[] = [],
    scope?: CatalogScope,
): Promise<SkillScanResult> {
    // Clear first, not after: an edited SKILL.md's frontmatter
    // (runAs/inlineOnly/allowedTools/model) must not keep serving a
    // pre-edit value from a previous call's cache. Clearing an empty
    // map (the cold-start case) is a no-op, so cold start and reload
    // run the identical sequence rather than diverging.
    if (scope === undefined) clearSkillFrontmatterCache();

    // SlashNormalizedExecutionEnv wraps NodeExecutionEnv so listDir /
    // fileInfo / canonicalPath return forward-slash paths even on
    // Windows. pi-agent-core's `relativeEnvPath` compares with
    // `path.startsWith(root + "/")` and falls back to the unchanged
    // absolute path when separators don't match — on Windows that
    // makes `ignore` throw "path should be a path.relative()'d
    // string". Combined with `defaultSkillDirs` (also forward-slash
    // normalized) both sides of the comparison agree.
    const skillEnv = new SlashNormalizedExecutionEnv({ cwd: fsCwd });
    // Enabled builtins may ship their own skill dirs (BuiltinManifest
    // .skillDirs). They are appended after defaultSkillDirs so a user skill
    // of the same name still wins by first-wins, and a disabled builtin
    // contributes nothing — its dirs are never collected (see
    // registerBuiltinExtensions).
    const inputs = [...defaultSkillDirs(fsCwd), ...extensionSkillDirInputs(extensionDirs)];
    // Select roots before deduplication so shadowed definitions remain visible in their layer.
    const skillDirs =
        scope === undefined
            ? inputs
            : inputs.filter((input) => {
                  if (scope === "builtin") return input.source === "builtin";
                  const root = resolve(input.path);
                  return (
                      input.source === "user" &&
                      root ===
                          resolve(
                              scope === "global" ? tacoHome() : resolve(fsCwd, ".taco"),
                              "skills",
                          )
                  );
              });
    const loaded = await loadSourcedSkills<TacoSkill["source"], TacoSkill>(
        skillEnv,
        skillDirs,
        (skill, source): TacoSkill => ({ ...skill, source }),
        harnessContext,
    );
    // pi's loadSourcedSkills does not dedupe internally; defaultSkillDirs
    // places .taco/skills first and builtin last, so dedupeSkillsByName
    // gives ".taco wins, builtin falls back" first-match semantics.
    const deduped = dedupeSkillsByNameWithDuplicates(loaded.skills.map((entry) => entry.skill));
    const skills = deduped.kept;
    if (scope === undefined) preloadSkillFrontmatter(skills);
    // Stamp frontmatter-only fields (currently: inlineOnly, whenToUse) onto
    // each TacoSkill so skills.list can surface them. preloadSkillFrontmatter
    // must run first — readSkillFrontmatter returns from the cache. The
    // same pass lints the taco-private keys pi ignores, so a malformed
    // runAs/inlineOnly/allowedTools/whenToUse surfaces as a diagnostic here
    // rather than as a tool error at call time.
    const frontmatterDiagnostics: SkillDiagnosticEntry[] = [];
    for (const s of skills) {
        // Browsing a source must not change a running session's cached execution metadata.
        const fm =
            scope === undefined
                ? readSkillFrontmatter(s.filePath)
                : await readFile(s.filePath, "utf-8")
                      .then(parseYamlFrontmatter)
                      .catch((): Record<string, unknown> => ({}));
        if (fm.inlineOnly === true) {
            (s as TacoSkill).inlineOnly = true;
        }
        // typeof guard, not `!== undefined`: raw YAML yields null for an
        // empty `whenToUse:` and numbers/booleans for unquoted values —
        // `.trim()` on any of them would throw and abort the whole loop.
        if (typeof fm.whenToUse === "string" && fm.whenToUse.trim().length > 0) {
            (s as TacoSkill).whenToUse = fm.whenToUse.trim();
        }
        frontmatterDiagnostics.push(...checkSkillFrontmatter(fm, s.filePath));
    }
    // Logs stay: they are the only channel for headless / IM runs with no
    // client to read `skills.list`. The returned copy is additional, not a
    // replacement. The level contract — never warn, always info — lives in
    // logSkillDiagnostics so a single test can guard the toast-surfacing
    // contract: warn lines become desktop toasts on every boot and every
    // hot reload, which we don't want for known-shape skill hygiene
    // problems. Users still see them by opening the skills pane.
    const diagnostics = [
        ...mapLoaderDiagnostics(loaded.diagnostics),
        ...mapDuplicateDiagnostics(deduped.duplicates),
        ...frontmatterDiagnostics,
    ];
    if (scope === undefined)
        logSkillDiagnostics(
            {
                loader: diagnostics,
                frontmatter: frontmatterDiagnostics,
                duplicates: mapDuplicateDiagnostics(deduped.duplicates),
            },
            createLogger("sidecar"),
        );
    return { skills, diagnostics };
}
