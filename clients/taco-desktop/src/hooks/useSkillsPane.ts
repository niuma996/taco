import type { SkillDiagnosticEntry, SkillEntry } from "@taco-ai/protocol";
import { asWorkspaceId } from "@taco-ai/protocol";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { TacoClient } from "../lib/clients/tacoClient";
import { type ConfigurationScope, filterSkillScope } from "../lib/configurationScope";
import { queryError, resourceQueryKey } from "../lib/queries/queryClient";

export interface UseSkillsPaneResult {
    /** Skills matching the current query (case-insensitive name/description substring). */
    skills: SkillEntry[];
    /** Total loaded before filtering — the pane shows `shown/total` next to the search box. */
    totalCount: number;
    /** The latest list failure, cleared by a successful refetch. */
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

/** Cached remote data is independent from this pane's filter and selection. */
export function useSkillsPane(
    client: TacoClient,
    active: boolean,
    activeCwd: string | undefined,
    viewScope: ConfigurationScope = "effective",
): UseSkillsPaneResult {
    const [query, setQuery] = useState("");
    const [selection, setSelection] = useState({
        client,
        activeCwd,
        viewScope,
        name: null as string | null,
    });
    const list = useQuery({
        retry: false,
        queryKey: resourceQueryKey(client, "skills", activeCwd, viewScope),
        enabled: active && Boolean(activeCwd),
        queryFn: ({ signal }) => {
            signal.throwIfAborted();
            return client.skillsList({
                workspace: asWorkspaceId(activeCwd as string),
                ...(viewScope === "effective" ? {} : { scope: viewScope }),
            });
        },
    });
    const scopedSkills = useMemo(
        () => filterSkillScope(list.data?.skills ?? [], viewScope),
        [list.data, viewScope],
    );
    const currentSelection =
        selection.client === client &&
        selection.activeCwd === activeCwd &&
        selection.viewScope === viewScope
            ? selection.name
            : null;
    const selectedSkillName =
        currentSelection && scopedSkills.some((skill) => skill.name === currentSelection)
            ? currentSelection
            : (scopedSkills[0]?.name ?? null);
    const known = scopedSkills.find((skill) => skill.name === selectedSkillName);
    const content = useQuery({
        retry: false,
        queryKey: resourceQueryKey(client, "skill-content", activeCwd, viewScope, known?.filePath),
        enabled: active && Boolean(activeCwd && known),
        queryFn: ({ signal }) => {
            signal.throwIfAborted();
            return client.skillContent({
                workspace: asWorkspaceId(activeCwd as string),
                filePath: known?.filePath ?? "",
                ...(viewScope === "effective" ? {} : { scope: viewScope }),
            });
        },
    });
    const skills = useMemo(() => {
        const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
        return terms.length
            ? scopedSkills.filter((skill) => {
                  const text = `${skill.name} ${skill.description ?? ""}`.toLowerCase();
                  return terms.every((term) => text.includes(term));
              })
            : scopedSkills;
    }, [query, scopedSkills]);
    return {
        skills,
        totalCount: scopedSkills.length,
        query,
        setQuery,
        diagnostics: list.data?.diagnostics ?? [],
        skillsError: queryError(list.error)?.message ?? null,
        selectedSkillName,
        setSelectedSkillName: (name) => setSelection({ client, activeCwd, viewScope, name }),
        skillContent: known ? (content.data?.content ?? "") : "",
        skillContentLoading: Boolean(known) && content.isFetching,
        skillContentError: queryError(content.error)?.message ?? null,
    };
}
