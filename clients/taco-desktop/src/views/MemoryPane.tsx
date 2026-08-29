/**
 * MemoryPane — memory panel view (shown when mainView = 'memory').
 *
 * Pure view: data is held by App.tsx and passed via props (mirrors SkillsPane).
 * Left column: global MEMORY.md (editable, with local draft) + project topics.
 * Right column: detail view for the selected entry. When onSaveMemory returns
 * { code: "memory.conflict", data } the conflict UI takes over.
 */

import { Pencil, RefreshCw, Save, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ConfirmModal } from "../components/ConfirmModal";
import { PaneHeader } from "../components/PaneHeader";
import { useT } from "../i18n/useI18n";
import type { MemoryConflictPayload, MemoryListResult, MemoryTopicEntry } from "../lib/memoryPaneTypes";
import { MEMORY_ROOT_ID } from "../lib/memoryPaneTypes";

export interface MemoryPaneProps {
    data: MemoryListResult | null;
    loading: boolean;
    error: string | null;
    /** Defaults to MEMORY_ROOT_ID. After deleting a topic, App.tsx falls back to MEMORY_ROOT_ID. */
    selectedId: string;
    onSelect: (id: string) => void;
    /** App.tsx issues the RPC and refetches. The component only surfaces conflict results; toast handling stays in App. */
    onSaveMemory: (
        content: string,
        baseHash: string,
    ) => Promise<{ ok: true } | { ok: false; conflict: MemoryConflictPayload }>;
    onDeleteTopic: (id: string) => Promise<void>;
    onRefresh: () => void;
    /** Held by App.tsx to prevent duplicate submits. */
    saving: boolean;
}

export function MemoryPane(props: MemoryPaneProps) {
    const {
        data,
        loading,
        error,
        selectedId,
        onSelect,
        onSaveMemory,
        onDeleteTopic,
        onRefresh,
        saving,
    } = props;
    const { t } = useT();

    const [isEditing, setIsEditing] = useState(false);
    const [draft, setDraft] = useState<string>("");
    const [conflict, setConflict] = useState<MemoryConflictPayload | null>(null);
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
    const [confirmDiscard, setConfirmDiscard] = useState(false);
    const [query, setQuery] = useState("");

    const isMemorySelected = selectedId === MEMORY_ROOT_ID;
    const selectedTopic: MemoryTopicEntry | undefined = data?.topics.find(
        (topic) => topic.id === selectedId,
    );

    // Case-insensitive topic filter; the global MEMORY.md entry always stays
    // pinned at top and is never filtered out.
    const filteredTopics = useMemo(() => {
        const topics = data?.topics ?? [];
        const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
        if (terms.length === 0) return topics;
        return topics.filter((topic) => {
            const haystack = `${topic.name} ${topic.type} ${topic.description ?? ""}`.toLowerCase();
            return terms.every((term) => haystack.includes(term));
        });
    }, [data?.topics, query]);

    // While editing, ignore external refreshes that would clobber the draft.
    useEffect(() => {
        if (isEditing) return;
        setDraft(data?.memoryContent ?? "");
    }, [data?.memoryContent, isEditing]);

    if (!data) {
        if (loading) {
            return (
                <div className="memory-pane">
                    <div className="memory-list">
                        <div className="pane-header">{t("memory.title")}</div>
                        <div className="memory-list-empty">{t("memory.loading")}</div>
                    </div>
                    <div className="memory-detail memory-detail-placeholder">
                        {t("memory.loading")}
                    </div>
                </div>
            );
        }
        return (
            <div className="memory-pane">
                <div className="memory-list">
                    <div className="pane-header">{t("memory.title")}</div>
                </div>
                <div className="memory-detail memory-detail-error">
                    {error ?? t("memory.errorLoad")}
                </div>
            </div>
        );
    }

    if (!data.enabled) {
        return (
            <div className="memory-pane">
                <div className="memory-list">
                    <div className="pane-header">{t("memory.title")}</div>
                </div>
                <div className="memory-detail memory-detail-disabled">
                    <h2>{t("memory.disabledState")}</h2>
                    <p>{t("memory.disabledHint")}</p>
                </div>
            </div>
        );
    }

    const isMemoryEmpty = data.memoryContent.trim() === "# Memory" && data.topics.length === 0;

    const handleStartEdit = () => {
        setDraft(data.memoryContent);
        setIsEditing(true);
    };

    const handleCancelEdit = () => {
        if (draft !== data.memoryContent) {
            setConfirmDiscard(true);
            return;
        }
        setIsEditing(false);
    };

    const handleSave = async () => {
        const result = await onSaveMemory(draft, data.memoryHash);
        if (result.ok) {
            setIsEditing(false);
            return;
        }
        // Conflict: hand off to the conflict modal.
        setConflict(result.conflict);
    };

    const handleConflictOverwrite = async () => {
        if (!conflict) return;
        const result = await onSaveMemory(draft, conflict.currentHash);
        setConflict(null);
        if (result.ok) {
            setIsEditing(false);
        } else {
            // Hash changed under us again — re-surface the conflict so the user can retry.
            setConflict(result.conflict);
        }
    };

    const handleConflictDiscard = () => {
        if (!conflict) return;
        setDraft(conflict.currentContent);
        setConflict(null);
    };

    const handleConflictCancel = () => {
        setConflict(null);
    };

    const handleDelete = async () => {
        if (!confirmDeleteId) return;
        await onDeleteTopic(confirmDeleteId);
        setConfirmDeleteId(null);
        onSelect(MEMORY_ROOT_ID);
    };

    return (
        <div className="memory-pane">
            <div className="memory-list">
                {/* Counts cover topics only. The global MEMORY.md row is pinned and
                    never filtered, so including it would report "1/3" on a query
                    that actually matched no topics. */}
                <PaneHeader
                    title={t("memory.title")}
                    count={data.topics.length}
                    shownCount={filteredTopics.length}
                    query={query}
                    onQueryChange={setQuery}
                >
                    <button
                        type="button"
                        className="memory-refresh-btn"
                        onClick={onRefresh}
                        title={t("memory.refresh")}
                        disabled={loading}
                    >
                        <RefreshCw size={14} aria-hidden="true" />
                    </button>
                </PaneHeader>

                <div className="memory-list-body">
                    <div className="memory-list-section-label">{t("memory.globalLabel")}</div>
                    <button
                        type="button"
                        className={`memory-list-item${isMemorySelected ? " active" : ""}`}
                        onClick={() => onSelect(MEMORY_ROOT_ID)}
                    >
                        <span className="memory-list-item-name">{t("memory.globalName")}</span>
                        <span className="memory-list-item-badge">{t("memory.globalLabel")}</span>
                    </button>

                    <div className="memory-list-section-label">
                        {t("memory.projectTopicsLabel")} ({filteredTopics.length})
                    </div>
                    {filteredTopics.length === 0 ? (
                        <div className="memory-list-empty">
                            {query ? t("pane.noMatch") : t("memory.noTopics")}
                        </div>
                    ) : (
                        filteredTopics.map((topic) => (
                            <button
                                key={topic.id}
                                type="button"
                                className={`memory-list-item${selectedId === topic.id ? " active" : ""}`}
                                onClick={() => onSelect(topic.id)}
                            >
                                <span className="memory-list-item-name">{topic.name}</span>
                                <span className="memory-list-item-badge">{topic.type}</span>
                            </button>
                        ))
                    )}
                </div>
            </div>

            <div className="memory-detail">
                {isMemoryEmpty && !isEditing ? (
                    <div className="memory-detail-placeholder">
                        <p>{t("memory.emptyState")}</p>
                    </div>
                ) : isMemorySelected ? (
                    isEditing ? (
                        <div className="memory-edit">
                            <textarea
                                className="memory-edit-textarea"
                                value={draft}
                                onChange={(e) => setDraft(e.target.value)}
                                disabled={saving}
                            />
                            <div className="memory-edit-actions">
                                <button
                                    type="button"
                                    className="memory-edit-cancel"
                                    onClick={handleCancelEdit}
                                    disabled={saving}
                                >
                                    {t("memory.cancel")}
                                </button>
                                <button
                                    type="button"
                                    className="memory-edit-save"
                                    onClick={handleSave}
                                    disabled={saving || draft === data.memoryContent}
                                >
                                    <Save size={14} aria-hidden="true" />
                                    {t("memory.save")}
                                </button>
                            </div>
                        </div>
                    ) : (
                        <div className="memory-view">
                            <div className="memory-view-header">
                                <h2 className="memory-view-name">{t("memory.globalName")}</h2>
                                <button
                                    type="button"
                                    className="memory-edit-btn"
                                    onClick={handleStartEdit}
                                >
                                    <Pencil size={14} aria-hidden="true" />
                                    {t("memory.edit")}
                                </button>
                            </div>
                            <pre className="memory-view-content">{data.memoryContent}</pre>
                        </div>
                    )
                ) : selectedTopic ? (
                    <div className="memory-view">
                        <div className="memory-view-header">
                            <h2 className="memory-view-name">{selectedTopic.name}</h2>
                            <button
                                type="button"
                                className="memory-delete-btn"
                                onClick={() => setConfirmDeleteId(selectedTopic.id)}
                            >
                                <Trash2 size={14} aria-hidden="true" />
                                {t("memory.delete")}
                            </button>
                        </div>
                        <dl className="memory-view-meta">
                            <dt>{t("memory.idLabel")}</dt>
                            <dd>
                                <code>{selectedTopic.id}</code>
                            </dd>
                            <dt>{t("memory.typeLabel")}</dt>
                            <dd>{selectedTopic.type}</dd>
                            <dt>{t("memory.createdLabel")}</dt>
                            <dd>{selectedTopic.createdAt}</dd>
                            {selectedTopic.updatedAt && (
                                <>
                                    <dt>{t("memory.updatedLabel")}</dt>
                                    <dd>{selectedTopic.updatedAt}</dd>
                                </>
                            )}
                            {selectedTopic.description && (
                                <>
                                    <dt>description</dt>
                                    <dd>{selectedTopic.description}</dd>
                                </>
                            )}
                        </dl>
                        <div className="memory-view-content">{selectedTopic.content}</div>
                    </div>
                ) : (
                    <div className="memory-detail-placeholder">{t("memory.loading")}</div>
                )}
            </div>

            <ConfirmModal
                open={confirmDeleteId !== null}
                title={t("memory.deleteTopicTitle")}
                message={t("memory.deleteTopicBody")}
                confirmLabel={t("memory.delete")}
                cancelLabel={t("memory.cancel")}
                onConfirm={() => {
                    void handleDelete();
                }}
                onCancel={() => setConfirmDeleteId(null)}
            />

            <ConfirmModal
                open={confirmDiscard}
                title={t("memory.discardUnsavedTitle")}
                message={t("memory.discardUnsavedBody")}
                confirmLabel={t("memory.discard")}
                cancelLabel={t("memory.cancel")}
                onConfirm={() => {
                    setConfirmDiscard(false);
                    setIsEditing(false);
                }}
                onCancel={() => setConfirmDiscard(false)}
            />

            <ConfirmModal
                open={conflict !== null}
                title={t("memory.conflictTitle")}
                message={t("memory.conflictBody")}
                confirmLabel={t("memory.overwriteMine")}
                cancelLabel={t("memory.cancel")}
                onConfirm={() => {
                    void handleConflictOverwrite();
                }}
                onCancel={handleConflictCancel}
            />
            {conflict && (
                <div className="memory-conflict-extra">
                    <button
                        type="button"
                        className="memory-conflict-discard"
                        onClick={handleConflictDiscard}
                    >
                        {t("memory.discardMine")}
                    </button>
                </div>
            )}
        </div>
    );
}
