/**
 * skillFrontmatter — sync YAML frontmatter parser for skill files.
 * pi-agent-core's loadSourcedSkills discards extra frontmatter fields, so we
 * re-parse here. preloadSkillFrontmatter caches per filePath so the hot path
 * avoids I/O.
 */

import { readFileSync } from "node:fs";
import type { Skill } from "@earendil-works/pi-agent-core";
import matter from "gray-matter";

export interface SkillFrontmatter {
    runAs?: "inline" | "subagent";
    allowedTools?: string[];
    model?: string;
    /**
     * When true, the skill must only be activated inline — running it inside
     * a subagent makes no sense (the subagent cannot dispatch tools back into
     * the parent session). `SkillTool` enforces this: a request to invoke an
     * `inlineOnly` skill in `subagent` mode returns an explicit error so the
     * model can correct the call instead of silently running the wrong shape.
     */
    inlineOnly?: boolean;
}

/**
 * Parse top-level YAML frontmatter from a markdown file.
 * Returns an empty object when no `---` block is present.
 */
export function parseYamlFrontmatter(content: string): Record<string, unknown> {
    return matter(content).data ?? {};
}

// ── cache ─────────────────────────────────────────────────────────────────────

const frontmatterCache = new Map<string, SkillFrontmatter>();

/** Bulk-preload frontmatter for all loaded skills. Call once after loadSourcedSkills. */
export function preloadSkillFrontmatter(skills: Skill[]): void {
    for (const s of skills) {
        if (frontmatterCache.has(s.filePath)) continue;
        try {
            const content = readFileSync(s.filePath, "utf-8");
            frontmatterCache.set(
                s.filePath,
                (parseYamlFrontmatter(content) ?? {}) as SkillFrontmatter,
            );
        } catch {
            frontmatterCache.set(s.filePath, {});
        }
    }
}

/**
 * Read frontmatter from cache. Falls back to sync read only if preload wasn't
 * called (tests / edge cases).
 */
export function readSkillFrontmatter(filePath: string): SkillFrontmatter {
    const cached = frontmatterCache.get(filePath);
    if (cached) return cached;
    try {
        const content = readFileSync(filePath, "utf-8");
        const parsed = (parseYamlFrontmatter(content) ?? {}) as SkillFrontmatter;
        frontmatterCache.set(filePath, parsed);
        return parsed;
    } catch {
        frontmatterCache.set(filePath, {});
        return {};
    }
}
