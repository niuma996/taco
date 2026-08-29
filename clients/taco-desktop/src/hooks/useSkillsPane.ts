import type { SkillDiagnosticEntry, SkillEntry } from "@taco-ai/protocol";
import { useEffect, useMemo, useState } from "react";
import type { TacoClient } from "../lib/tacoClientTauri.ts";

export interface UseSkillsPaneResult {
    /** Skills matching the current query (case-insensitive name/description substring). */
    skills: SkillEntry[];
    /** Total loaded before filtering — the pane shows `shown/total` next to the search box. */
    totalCount: number;
    query: string;
    setQuery: (q: string) => void;
    diagnostics: SkillDiagnosticEntry[];
    selectedSkillName: string | null;
    setSelectedSkillName: (name: string | null) => void;
    skillContent: string;
    skillContentLoading: boolean;
    skillContentError: string | null;
}

/** Loads the skills list + selected skill content when the skills pane is active. */
export function useSkillsPane(
    client: TacoClient,
    active: boolean,
    activeCwd: string | undefined,
): UseSkillsPaneResult {
    const [allSkills, setAllSkills] = useState<SkillEntry[]>([]);
    const [query, setQuery] = useState("");
    const [diagnostics, setDiagnostics] = useState<SkillDiagnosticEntry[]>([]);
    const [selectedSkillName, setSelectedSkillName] = useState<string | null>(null);
    const [skillContent, setSkillContent] = useState<string>("");
    const [skillContentLoading, setSkillContentLoading] = useState(false);
    const [skillContentError, setSkillContentError] = useState<string | null>(null);

    // Case-insensitive fuzzy-ish filter: every whitespace-separated term must
    // appear in the name or description, so "release note" matches release-notes.
    const skills = useMemo(() => {
        const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
        if (terms.length === 0) return allSkills;
        return allSkills.filter((s) => {
            const haystack = `${s.name} ${s.description ?? ""}`.toLowerCase();
            return terms.every((t) => haystack.includes(t));
        });
    }, [allSkills, query]);

    // Load list + auto-select first item so the content effect fires on entry.
    useEffect(() => {
        if (!active || !activeCwd) return;
        // reset selection + content so previous workspace's state doesn't leak through
        setSelectedSkillName(null);
        setSkillContent("");
        setSkillContentError(null);
        void client
            .skillsList(activeCwd)
            .then((r) => {
                setAllSkills(r.skills);
                setDiagnostics(r.diagnostics ?? []);
                if (r.skills.length > 0) {
                    setSelectedSkillName(r.skills[0].name);
                }
            })
            .catch((e) => {
                console.error("[useSkillsPane] skillsList failed:", e);
            });
    }, [active, activeCwd, client]);

    // Fetch skill content when user picks a skill.
    // Cancellation flag prevents slow earlier requests from overwriting later selections.
    useEffect(() => {
        let cancelled = false;
        setSkillContent("");
        setSkillContentError(null);
        if (!selectedSkillName || !activeCwd) return;
        const target = selectedSkillName;
        const known = allSkills.find((s) => s.name === target);
        if (!known) return;
        setSkillContentLoading(true);
        void client
            .skillContent(activeCwd, known.filePath)
            .then((r) => {
                if (cancelled) return;
                setSkillContent(r.content);
                setSkillContentError(null);
            })
            .catch((e) => {
                if (cancelled) return;
                setSkillContentError((e as Error).message);
                setSkillContent("");
            })
            .finally(() => {
                if (!cancelled) setSkillContentLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [selectedSkillName, activeCwd, allSkills, client]);

    return {
        skills,
        totalCount: allSkills.length,
        query,
        setQuery,
        diagnostics,
        selectedSkillName,
        setSelectedSkillName,
        skillContent,
        skillContentLoading,
        skillContentError,
    };
}
