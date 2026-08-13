/**
 * SkillsPane — skill list panel (shown when mainView = 'skills').
 *
 * Left column: loaded skills; right column: detail view (name, description,
 * path, content preview). Pure view — content fetching lives in App.tsx.
 */

import type { SkillEntry } from "@taco-ai/protocol";

import { useT } from "../i18n/useI18n";

export interface SkillsPaneProps {
    skills: SkillEntry[];
    selectedName: string | null;
    onSelect: (name: string) => void;
    content: string;
    contentLoading: boolean;
    contentError: string | null;
}

export function SkillsPane({
    skills,
    selectedName,
    onSelect,
    content,
    contentLoading,
    contentError,
}: SkillsPaneProps) {
    const { t } = useT();
    const selected = selectedName ?? skills[0]?.name ?? null;
    const selectedSkill = skills.find((s) => s.name === selected) ?? null;

    return (
        <div className="skills-pane">
            <div className="skills-list">
                <div className="pane-header">
                    <span>
                        {t("activity.skills")} ({skills.length})
                    </span>
                </div>
                {skills.length === 0 ? (
                    <div className="skills-list-empty">
                        {t("activity.skillsEmptyState")}
                        <br />
                        {t("activity.skillsEmptyHint")}
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
                        <p className="skills-detail-path">{selectedSkill.filePath}</p>
                        <div className="skills-detail-content-label">
                            {t("activity.contentLabel")}
                        </div>
                        {contentLoading ? (
                            <p className="skills-detail-loading">{t("activity.loading")}</p>
                        ) : contentError ? (
                            <p className="skills-detail-content-error">{contentError}</p>
                        ) : content ? (
                            <pre className="skills-detail-content">{content}</pre>
                        ) : null}
                    </>
                )}
            </div>
        </div>
    );
}
