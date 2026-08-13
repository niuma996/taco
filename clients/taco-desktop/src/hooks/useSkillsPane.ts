import type { SkillEntry } from "@taco-ai/protocol";
import { useEffect, useState } from "react";
import type { TacoClient } from "../lib/tacoClientTauri.ts";

export interface UseSkillsPaneResult {
    skills: SkillEntry[];
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
    const [skills, setSkills] = useState<SkillEntry[]>([]);
    const [selectedSkillName, setSelectedSkillName] = useState<string | null>(null);
    const [skillContent, setSkillContent] = useState<string>("");
    const [skillContentLoading, setSkillContentLoading] = useState(false);
    const [skillContentError, setSkillContentError] = useState<string | null>(null);

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
                setSkills(r.skills);
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
        const known = skills.find((s) => s.name === target);
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
    }, [selectedSkillName, activeCwd, skills, client]);

    return {
        skills,
        selectedSkillName,
        setSelectedSkillName,
        skillContent,
        skillContentLoading,
        skillContentError,
    };
}
