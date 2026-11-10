import { asWorkspaceId, type SkillDiagnosticEntry, type SkillEntry } from "@taco-ai/protocol";
import { useEffect, useMemo, useState } from "react";
import type { TacoClient } from "../lib/clients/tacoClient.ts";
import { type ConfigurationScope, filterSkillScope } from "../lib/configurationScope";
import { useAutoClearError } from "./primitives/useAutoClearError";

export interface UseSkillsPaneResult {
    /** Skills matching the current query (case-insensitive name/description substring). */
    skills: SkillEntry[];
    /** Total loaded before filtering — the pane shows `shown/total` next to the search box. */
    totalCount: number;
    /** Non-null when the skills list fetch failed; clears itself after a few seconds. */
    skillsError: string | null;
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
    viewScope: ConfigurationScope = "effective",
): UseSkillsPaneResult {
    const [allSkills, setAllSkills] = useState<SkillEntry[]>([]);
    const {
        error: skillsError,
        fail: failSkillsList,
        clearError: clearSkillsError,
    } = useAutoClearError();
    const [query, setQuery] = useState("");
    const [diagnostics, setDiagnostics] = useState<SkillDiagnosticEntry[]>([]);
    const [selectedSkillName, setSelectedSkillName] = useState<string | null>(null);
    const [skillContent, setSkillContent] = useState<string>("");
    const [skillContentLoading, setSkillContentLoading] = useState(false);
    const {
        error: skillContentError,
        fail: failSkillContent,
        clearError: clearSkillContentError,
    } = useAutoClearError();

    const scopedSkills = useMemo(
        () => filterSkillScope(allSkills, viewScope),
        [allSkills, viewScope],
    );

    // Case-insensitive fuzzy-ish filter: every whitespace-separated term must
    // appear in the name or description, so "release note" matches release-notes.
    const skills = useMemo(() => {
        const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
        if (terms.length === 0) return scopedSkills;
        return scopedSkills.filter((s) => {
            const haystack = `${s.name} ${s.description ?? ""}`.toLowerCase();
            return terms.every((t) => haystack.includes(t));
        });
    }, [scopedSkills, query]);

    // Load list + auto-select first item so the content effect fires on entry.
    useEffect(() => {
        if (!active) return;
        // reset selection + content so previous workspace's state doesn't leak through
        setSelectedSkillName(null);
        setSkillContent("");
        clearSkillContentError();
        clearSkillsError();
        setAllSkills([]);
        if (!activeCwd) return;
        let cancelled = false;
        void client
            .skillsList({
                workspace: asWorkspaceId(activeCwd),
                ...(viewScope === "effective" ? {} : { scope: viewScope }),
            })
            .then((r) => {
                if (cancelled) return;
                setAllSkills(r.skills);
                setDiagnostics(r.diagnostics ?? []);
                const visible = filterSkillScope(r.skills, viewScope);
                if (visible.length > 0) setSelectedSkillName(visible[0].name);
            })
            .catch((e: unknown) => {
                if (cancelled) return;
                console.error("[useSkillsPane] skillsList failed:", e);
                failSkillsList(e);
            });
        return () => {
            cancelled = true;
        };
    }, [
        active,
        activeCwd,
        viewScope,
        client,
        clearSkillContentError,
        clearSkillsError,
        failSkillsList,
    ]);

    // Fetch skill content when user picks a skill.
    // Cancellation flag prevents slow earlier requests from overwriting later selections.
    useEffect(() => {
        let cancelled = false;
        setSkillContent("");
        clearSkillContentError();
        setSkillContentLoading(false);
        if (!active || !selectedSkillName || !activeCwd) return;
        const target = selectedSkillName;
        const known = allSkills.find((s) => s.name === target);
        if (!known) return;
        setSkillContentLoading(true);
        void client
            .skillContent({
                workspace: asWorkspaceId(activeCwd),
                filePath: known.filePath,
                ...(viewScope === "effective" ? {} : { scope: viewScope }),
            })
            .then((r) => {
                if (cancelled) return;
                setSkillContent(r.content);
            })
            .catch((e: unknown) => {
                if (cancelled) return;
                failSkillContent(e);
                setSkillContent("");
            })
            .finally(() => {
                if (!cancelled) setSkillContentLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [
        active,
        selectedSkillName,
        activeCwd,
        allSkills,
        client,
        viewScope,
        clearSkillContentError,
        failSkillContent,
    ]);

    return {
        skills,
        totalCount: scopedSkills.length,
        skillsError,
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
