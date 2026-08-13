/**
 * Dedupe a skill array by the `name` field. First occurrence wins — the array's
 * order is the priority. Caller puts `.taco/skills` first and builtins last so
 * user skills override builtins.
 */

export function dedupeSkillsByName<T extends { name: string }>(skills: ReadonlyArray<T>): T[] {
    const seen = new Set<string>();
    const out: T[] = [];
    for (const s of skills) {
        if (seen.has(s.name)) continue;
        seen.add(s.name);
        out.push(s);
    }
    return out;
}
