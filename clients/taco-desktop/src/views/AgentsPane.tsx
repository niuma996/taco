/**
 * AgentsPane — full-screen sub-agent view (4th sidebar entry).
 *
 * Left: list (agentType + source) with a "new agent" action; right: detail
 * (description, whenToUse, rendered systemPrompt) with edit/delete for
 * user agents that live in a directory the editor owns (global or workspace).
 * Data fetching and mutations live in useAgentsPane (App.tsx).
 */

import type { AgentEntry, AgentRuntime, AgentsContentResult } from "@taco-ai/protocol";
import { type ReactElement, useMemo, useState } from "react";
import { AssistantMarkdown } from "../components/AssistantMarkdown";
import { AddAgentMenu } from "../components/agents/AddAgentMenu";
import { AgentForm, type AgentFormValue, defaultMaxTurns } from "../components/agents/AgentForm";
import { ConfirmModal } from "../components/ConfirmModal";
import { PaneHeader } from "../components/PaneHeader";
import { Button } from "../components/ui/Button";
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
    /** False for IM conversations: they have no project directory to hold a workspace-scoped agent. */
    hasProjectDir: boolean;
    /** Directories a Claude Code agent may run in; the first is the default. */
    cwdChoices: ReadonlyArray<string>;
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
    hasProjectDir,
    cwdChoices,
    onSaveAgent,
    onDeleteAgent,
}: AgentsPaneProps): ReactElement {
    const { t } = useT();
    const [query, setQuery] = useState("");
    // `new` carries the runtime picked from the add menu; edit reads it off
    // the selected agent, since a definition's runtime is fixed once created.
    const [formOpen, setFormOpen] = useState<
        false | { mode: "new"; runtime: AgentRuntime } | { mode: "edit" }
    >(false);
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
    const selectedEditable = selectedAgent?.editable === true;

    const saveForm = async (value: AgentFormValue) => {
        setFormError(null);
        try {
            await onSaveAgent(
                value,
                formOpen !== false && formOpen.mode === "edit" && selectedAgent
                    ? selectedAgent.agentType
                    : undefined,
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
                    <AddAgentMenu
                        onPick={(runtime) => {
                            setFormError(null);
                            setFormOpen({ mode: "new", runtime });
                        }}
                    />
                </PaneHeader>
                {error && (
                    <div className="error-banner" role="alert">
                        {error}
                    </div>
                )}
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
                                {a.scope === "workspace" && (
                                    <span className="agents-list-item-source">
                                        {t("agents.scope.workspace")}
                                    </span>
                                )}
                            </button>
                        ))
                    )}
                </div>
            </div>
            <div className="agents-detail">
                {selectedAgent ? (
                    <>
                        <div className="agents-detail-header">
                            <div className="agents-detail-title-row">
                                <h2 className="agents-detail-name">{selectedAgent.agentType}</h2>
                                {selectedEditable && (
                                    <div className="agents-detail-actions">
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            disabled={saving || contentLoading || !content}
                                            onClick={() => {
                                                setFormError(null);
                                                setFormOpen({ mode: "edit" });
                                            }}
                                        >
                                            {t("agents.edit")}
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            disabled={saving}
                                            onClick={() => {
                                                setActionError(null);
                                                setConfirmDelete(true);
                                            }}
                                        >
                                            {t("agents.delete")}
                                        </Button>
                                    </div>
                                )}
                            </div>
                            <div className="agents-detail-meta">
                                <span className="agents-detail-tag">
                                    {selectedAgent.runtime === "claude-code"
                                        ? t("agents.runtimeCc")
                                        : t("agents.runtimeStandard")}
                                </span>
                                <span className="agents-detail-tag">
                                    {selectedAgent.scope !== undefined
                                        ? t(`agents.scope.${selectedAgent.scope}`)
                                        : selectedAgent.source}
                                </span>
                                {selectedAgent.runtime === "claude-code" &&
                                    content?.agentType === selectedAgent.agentType && (
                                        <span className="agents-detail-tag">
                                            {t(
                                                `agents.form.ccMode.${content.permissionMode ?? "auto"}`,
                                            )}
                                        </span>
                                    )}
                                {content?.agentType === selectedAgent.agentType &&
                                    content.maxTurns !== undefined && (
                                        <span className="agents-detail-tag">
                                            {t("agents.form.maxTurns")} {content.maxTurns}
                                        </span>
                                    )}
                            </div>
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
                            content.systemPrompt.trim() === "" ? (
                                <p className="agents-detail-content-empty">
                                    {t("agents.detailNoPrompt")}
                                </p>
                            ) : (
                                <AssistantMarkdown
                                    className="agents-detail-content"
                                    text={content.systemPrompt}
                                />
                            )
                        ) : null}
                    </>
                ) : (
                    <div className="agents-empty">{t("activity.selectAgentPrompt")}</div>
                )}
            </div>
            {formOpen !== false && (
                <AgentForm
                    runtime={
                        formOpen.mode === "new"
                            ? formOpen.runtime
                            : (selectedAgent?.runtime ?? "standard")
                    }
                    existing={
                        formOpen.mode === "edit" && content && selectedAgent
                            ? {
                                  scope: selectedAgent.scope ?? "global",
                                  agentType: selectedAgent.agentType,
                                  description: selectedAgent.description,
                                  whenToUse: selectedAgent.whenToUse,
                                  runtime: selectedAgent.runtime ?? "standard",
                                  maxTurns:
                                      content.maxTurns ??
                                      defaultMaxTurns(selectedAgent.runtime ?? "standard"),
                                  systemPrompt: content.systemPrompt,
                                  tools: content.tools,
                                  permissionMode: content.permissionMode,
                                  cwd: content.cwd,
                              }
                            : undefined
                    }
                    saving={saving}
                    hasProjectDir={hasProjectDir}
                    cwdChoices={cwdChoices}
                    shadowedTypes={agents
                        .filter((a) => a.scope === "global")
                        .map((a) => a.agentType)}
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
                error={actionError}
                busy={saving}
                onConfirm={confirmDeleteSelected}
                onCancel={() => setConfirmDelete(false)}
            />
        </div>
    );
}
