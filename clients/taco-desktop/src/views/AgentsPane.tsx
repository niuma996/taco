/**
 * AgentsPane — full-screen sub-agent view (4th sidebar entry).
 *
 * Left: list (agentType + source) with a "new agent" action; right: detail
 * (description, whenToUse, rendered systemPrompt) with edit/delete for
 * user agents that live in $TACO_HOME/agents. v1 edits claude-code agents
 * only — pi agents need a tools whitelist UI that is out of scope here.
 * Data fetching and mutations live in useAgentsPane (App.tsx).
 */

import type { AgentEntry, AgentsContentResult } from "@taco-ai/protocol";
import { type ReactElement, useMemo, useState } from "react";
import { AssistantMarkdown } from "../components/AssistantMarkdown";
import { AgentForm, type AgentFormValue } from "../components/agents/AgentForm";
import { ConfirmModal } from "../components/ConfirmModal";
import { PaneHeader } from "../components/PaneHeader";
import { Button } from "../components/ui/Button";
import { IconButton } from "../components/ui/IconButton";
import type { AgentSaveInput } from "../hooks/useAgentsPane";
import { useT } from "../i18n/useI18n";

export interface AgentsPaneProps {
    agents: AgentEntry[];
    error: string | null;
    selectedAgentType: string | null;
    onSelect: (agentType: string) => void;
    content: AgentsContentResult | null;
    contentLoading: boolean;
    contentError: string | null;
    saving: boolean;
    onSaveAgent: (input: AgentSaveInput, previousAgentType?: string) => Promise<void>;
    onDeleteAgent: (agentType: string) => Promise<void>;
}

export function AgentsPane({
    agents,
    error,
    selectedAgentType,
    onSelect,
    content,
    contentLoading,
    contentError,
    saving,
    onSaveAgent,
    onDeleteAgent,
}: AgentsPaneProps): ReactElement {
    const { t } = useT();
    const [query, setQuery] = useState("");
    const [formOpen, setFormOpen] = useState<false | "new" | "edit">(false);
    const [formError, setFormError] = useState<string | null>(null);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [actionError, setActionError] = useState<string | null>(null);

    // Case-insensitive filter over agentType + description; every
    // whitespace-separated term must match.
    const filtered = useMemo(() => {
        const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
        if (terms.length === 0) return agents;
        return agents.filter((a) => {
            const haystack = `${a.agentType} ${a.description ?? ""}`.toLowerCase();
            return terms.every((term) => haystack.includes(term));
        });
    }, [agents, query]);
    const selected = selectedAgentType ?? filtered[0]?.agentType ?? null;
    const selectedAgent = agents.find((a) => a.agentType === selected) ?? null;
    const selectedEditable =
        selectedAgent?.editable === true && selectedAgent.runtime === "claude-code";

    const saveForm = async (value: AgentFormValue) => {
        setFormError(null);
        try {
            await onSaveAgent(
                value,
                formOpen === "edit" && selectedAgent ? selectedAgent.agentType : undefined,
            );
            setFormOpen(false);
        } catch (e) {
            setFormError(e instanceof Error ? e.message : String(e));
        }
    };

    const confirmDeleteSelected = async () => {
        if (!selectedAgent) return;
        setActionError(null);
        try {
            await onDeleteAgent(selectedAgent.agentType);
            setConfirmDelete(false);
        } catch (e) {
            setActionError(e instanceof Error ? e.message : String(e));
        }
    };

    return (
        <div className="agents-pane">
            <div className="agents-list">
                <PaneHeader
                    title={t("activity.agents")}
                    count={agents.length}
                    shownCount={filtered.length}
                    query={query}
                    onQueryChange={setQuery}
                >
                    <IconButton
                        aria-label={t("agents.new")}
                        onClick={() => {
                            setFormError(null);
                            setFormOpen("new");
                        }}
                    >
                        +
                    </IconButton>
                </PaneHeader>
                {error && <div className="error-banner">{error}</div>}
                {actionError && <div className="error-banner">{actionError}</div>}
                <div className="agents-list-body">
                    {filtered.length === 0 ? (
                        <div className="agents-empty">
                            {query ? t("pane.noMatch") : t("activity.noAgents")}
                        </div>
                    ) : (
                        filtered.map((a) => (
                            <button
                                key={a.agentType}
                                type="button"
                                className={`agents-list-item${selected === a.agentType ? " active" : ""}`}
                                onClick={() => onSelect(a.agentType)}
                            >
                                <span className="agents-list-item-name">{a.agentType}</span>
                                <span className="agents-list-item-source">
                                    {a.runtime === "claude-code" ? t("agents.runtimeCc") : a.source}
                                </span>
                            </button>
                        ))
                    )}
                </div>
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
                            {selectedEditable && (
                                <div className="agents-detail-actions">
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        disabled={saving || contentLoading || !content}
                                        onClick={() => {
                                            setFormError(null);
                                            setFormOpen("edit");
                                        }}
                                    >
                                        {t("agents.edit")}
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        disabled={saving}
                                        onClick={() => setConfirmDelete(true)}
                                    >
                                        {t("agents.delete")}
                                    </Button>
                                </div>
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
                            <AssistantMarkdown
                                className="agents-detail-content"
                                text={content.systemPrompt}
                            />
                        ) : null}
                    </>
                ) : (
                    <div className="agents-empty">{t("activity.selectAgentPrompt")}</div>
                )}
            </div>
            {formOpen !== false && (
                <AgentForm
                    existing={
                        formOpen === "edit" && content && selectedAgent
                            ? {
                                  agentType: selectedAgent.agentType,
                                  description: selectedAgent.description,
                                  whenToUse: selectedAgent.whenToUse,
                                  maxTurns: content.maxTurns ?? 30,
                                  systemPrompt: content.systemPrompt,
                              }
                            : undefined
                    }
                    saving={saving}
                    error={formError}
                    onSave={saveForm}
                    onCancel={() => setFormOpen(false)}
                />
            )}
            <ConfirmModal
                open={confirmDelete}
                title={t("agents.deleteTitle")}
                message={t("agents.deleteBody")}
                confirmLabel={t("agents.delete")}
                onConfirm={confirmDeleteSelected}
                onCancel={() => setConfirmDelete(false)}
            />
        </div>
    );
}
