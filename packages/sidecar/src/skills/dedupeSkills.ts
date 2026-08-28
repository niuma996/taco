/**
 * Dedupe a skill array by the `name` field. First occurrence wins — the array's
 * order is the priority. Caller puts `.taco/skills` first and builtins last so
 * user skills override builtins.
 */

/** A same-name collision: `dropped` lost to `keptFrom`, which appeared earlier. */
export interface SkillNameCollision<T> {
    name: string;
    dropped: T;
    keptFrom: T;
}

export interface DedupeSkillsResult<T> {
    kept: T[];
    /** One entry per discarded skill. Empty when every name was unique. */
    duplicates: Array<SkillNameCollision<T>>;
}

/**
 * Dedupe, and report what was discarded.
 *
 * pi-agent-core's `loadSourcedSkills` does not dedupe and therefore emits no
 * diagnostic for a name collision, so this is the only place a shadowed skill
 * can be noticed. Silently dropping it makes "I wrote a skill and nothing
 * happened" undebuggable when the name is already taken — hence the second
 * return value, mapped to a `duplicate_name` diagnostic by skillDiagnostics.ts.
 */
export function dedupeSkillsByNameWithDuplicates<T extends { name: string }>(
    skills: ReadonlyArray<T>,
): DedupeSkillsResult<T> {
    const winnerByName = new Map<string, T>();
    const kept: T[] = [];
    const duplicates: Array<SkillNameCollision<T>> = [];
    for (const s of skills) {
        const winner = winnerByName.get(s.name);
        if (winner) {
            duplicates.push({ name: s.name, dropped: s, keptFrom: winner });
            continue;
        }
        winnerByName.set(s.name, s);
        kept.push(s);
    }
    return { kept, duplicates };
}

/**
 * First-match-wins dedupe. Behavior is unchanged from before
 * `dedupeSkillsByNameWithDuplicates` existed; it delegates so there is exactly
 * one dedupe implementation to keep correct.
 */
export function dedupeSkillsByName<T extends { name: string }>(skills: ReadonlyArray<T>): T[] {
    return dedupeSkillsByNameWithDuplicates(skills).kept;
}
