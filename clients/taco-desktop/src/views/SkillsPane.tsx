/**
 * SkillsPane — skill list panel (shown when mainView = 'skills').
 *
 * Left column: fixed header (title + count + search) above a scrollable list;
 * right column: detail view (name, description, path, markdown content). Pure
 * view — content fetching lives in App.tsx, header/search are shared PaneHeader.
 */

import type { SkillDiagnosticEntry, SkillEntry } from "@taco-ai/protocol";

import { AssistantMarkdown } from "../components/AssistantMarkdown";
import { PaneHeader } from "../components/PaneHeader";
import { useT } from "../i18n/useI18n";
import { stripFrontmatter } from "../lib/markdownHelpers";

export interface SkillsPaneProps {
    skills: SkillEntry[];
    totalCount: number;
    skillsError: string | null;
    query: string;
    onQueryChange: (q: string) => void;
    diagnostics: SkillDiagnosticEntry[];
    selectedName: string | null;
    onSelect: (name: string) => void;
    content: string;
    contentLoading: boolean;
    contentError: string | null;
}

export function SkillsPane({
    skills,
    totalCount,
    skillsError,
    query,
    onQueryChange,
    diagnostics,
    selectedName,
    onSelect,
    content,
    contentLoading,
    contentError,
}: SkillsPaneProps) {
    const { t } = useT();
    const selected = selectedName ?? skills[0]?.name ?? null;
    const selectedSkill = skills.find((s) => s.name === selected) ?? null;

    // `duplicate_name` is expected behavior (priority dir wins a same-name
    // collision), not a load failure — keep it out of the warning-styled box.
    const overrideDiagnostics = diagnostics.filter((d) => d.code === "duplicate_name");
    const problemDiagnostics = diagnostics.filter((d) => d.code !== "duplicate_name");

    return (
        <div className="skills-pane">
            <div className="skills-list">
                <PaneHeader
                    title={t("activity.skills")}
                    count={totalCount}
                    shownCount={skills.length}
                    query={query}
                    onQueryChange={onQueryChange}
                />
                {skillsError && <div className="error-banner">{skillsError}</div>}
                <div className="skills-list-body">
                    {problemDiagnostics.length > 0 && (
                        <div className="skills-diagnostics" role="status">
                            <div className="skills-diagnostics-title">
                                {t("activity.skillsDiagnosticsTitle")}
                            </div>
                            {problemDiagnostics.map((d) => (
                                <div
                                    key={`${d.code}:${d.path}:${d.message}`}
                                    className="skills-diagnostic-item"
                                >
                                    <div className="skills-diagnostic-message">{d.message}</div>
                                    <div className="skills-diagnostic-path">{d.path}</div>
                                </div>
                            ))}
                        </div>
                    )}
                    {overrideDiagnostics.length > 0 && (
                        <div className="skills-diagnostics skills-diagnostics--info" role="status">
                            <div className="skills-diagnostics-title">
                                {t("activity.skillsDiagnosticsOverrideTitle", {
                                    count: overrideDiagnostics.length,
                                })}
                            </div>
                        </div>
                    )}
                    {skills.length === 0 ? (
                        <div className="skills-list-empty">
                            {query ? (
                                t("activity.skillsNoMatch")
                            ) : (
                                <>
                                    {t("activity.skillsEmptyState")}
                                    <br />
                                    {t("activity.skillsEmptyHint")}
                                </>
                            )}
                        </div>
                    ) : (
                        skills.map((skill) => (
                            <button
                                key={skill.name}
                                type="button"
                                className={`skills-list-item${selected === skill.name ? " active" : ""}`}
                                onClick={() => onSelect(skill.name)}
                            >
                                <span className="skills-list-item-name">{skill.name}</span>
                                <span className="skills-list-item-source">{skill.source}</span>
                            </button>
                        ))
                    )}
                </div>
            </div>
            <div className="skills-detail">
                {!selectedSkill ? (
                    <div className="skills-detail-placeholder">{t("tools.skillsSelectToView")}</div>
                ) : (
                    <>
                        <h2 className="skills-detail-name">{selectedSkill.name}</h2>
                        {selectedSkill.disableModelInvocation && (
                            <p className="skills-detail-meta">
                                <span className="skills-detail-tag">
                                    {t("activity.contentNotEditable")}
                                </span>
                            </p>
                        )}
                        <p className="skills-detail-description">
                            {selectedSkill.description || t("tools.noDescription")}
                        </p>
                        <div className="skills-detail-path-label">
                            {t("activity.contentPathLabel")}
                        </div>
                        <p className="skills-detail-path">
                            <code>{selectedSkill.filePath}</code>
                        </p>
                        <div className="skills-detail-content-label">
                            {t("activity.contentLabel")}
                        </div>
                        {contentLoading ? (
                            <p className="skills-detail-loading">{t("activity.loading")}</p>
                        ) : contentError ? (
                            <p className="skills-detail-content-error">{contentError}</p>
                        ) : content ? (
                            /* Frontmatter stripped: name/description are already
                               shown above, and `---` under text is setext syntax
                               that renders them as a stray heading. */
                            <AssistantMarkdown
                                className="skills-detail-content"
                                text={stripFrontmatter(content)}
                            />
                        ) : null}
                    </>
                )}
            </div>
        </div>
    );
}
