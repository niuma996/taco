/**
 * AgentsPane — full-screen sub-agent view (4th sidebar entry).
 *
 * Left: list (agentType + source); right: detail (description, whenToUse,
 * rendered systemPrompt). Pure view: content fetching lives in App.tsx.
 */

import type { AgentEntry } from "@taco-ai/protocol";
import type { ReactElement } from "react";
import { AssistantMarkdown } from "../components/AssistantMarkdown";
import { useT } from "../i18n/useI18n";

export interface AgentsPaneProps {
    agents: AgentEntry[];
    selectedAgentType: string | null;
    onSelect: (agentType: string) => void;
    content: string;
    contentLoading: boolean;
    contentError: string | null;
}

export function AgentsPane({
    agents,
    selectedAgentType,
    onSelect,
    content,
    contentLoading,
    contentError,
}: AgentsPaneProps): ReactElement {
    const { t } = useT();
    const selected = selectedAgentType ?? agents[0]?.agentType ?? null;
    const selectedAgent = agents.find((a) => a.agentType === selected) ?? null;

    return (
        <div className="agents-pane">
            <div className="agents-list">
                <div className="pane-header">
                    <span>
                        {t("activity.agents")} ({agents.length})
                    </span>
                </div>
                {agents.length === 0 ? (
                    <div className="agents-empty">{t("activity.noAgents")}</div>
                ) : (
                    agents.map((a) => (
                        <button
                            key={a.agentType}
                            type="button"
                            className={`agents-list-item${selected === a.agentType ? " active" : ""}`}
                            onClick={() => onSelect(a.agentType)}
                        >
                            <span className="agents-list-item-name">{a.agentType}</span>
                            <span className="agents-list-item-source">{a.source}</span>
                        </button>
                    ))
                )}
            </div>
            <div className="agents-detail">
                {selectedAgent ? (
                    <>
                        <div className="agents-detail-header">
                            <h2 className="agents-detail-name">{selectedAgent.agentType}</h2>
                            <p className="agents-detail-description">{selectedAgent.description}</p>
                            {selectedAgent.whenToUse && (
                                <p className="agents-detail-when-to-use">
                                    {selectedAgent.whenToUse}
                                </p>
                            )}
                        </div>
                        <div className="agents-detail-content-label">
                            {t("activity.systemPromptLabel")}
                        </div>
                        {contentLoading ? (
                            <p className="agents-detail-loading">{t("activity.loading")}</p>
                        ) : contentError ? (
                            <p className="agents-detail-content-error">{contentError}</p>
                        ) : content ? (
                            <AssistantMarkdown className="agents-detail-content" text={content} />
                        ) : null}
                    </>
                ) : (
                    <div className="agents-empty">{t("activity.selectAgentPrompt")}</div>
                )}
            </div>
        </div>
    );
}
