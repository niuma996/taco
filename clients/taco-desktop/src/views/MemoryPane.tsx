/**
 * MemoryPane — memory panel view (shown when mainView = 'memory').
 *
 * Pure view: data is held by App.tsx and passed via props (mirrors SkillsPane).
 * Left column: a type filter, the global MEMORY.md, live topics grouped by
 * recency, and a collapsed archive. Right column: the selected entry, or the
 * consolidation view the header's sparkle button opens.
 *
 * The consolidation controls used to sit above every entry, which made a
 * workspace-level setting read as part of the document below it. They now own
 * the right column while that view is open, and a pending preview keeps a dot
 * on the trigger so the state is still visible from the reading view.
 */

import { ChevronRight, Pencil, RefreshCw, Save, Sparkles, Trash } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AssistantMarkdown } from "../components/AssistantMarkdown";
import { ConfirmModal } from "../components/ConfirmModal";
import { type MemoryDreamActions, MemoryDreamPanel } from "../components/memory/MemoryDreamPanel";
import { PaneHeader } from "../components/PaneHeader";
import { Button } from "../components/ui/Button";
import { IconButton } from "../components/ui/IconButton";
import { useNow } from "../hooks/useNow";
import { useT, useUiLanguage } from "../i18n/useI18n";
import type {
    MemoryConflictPayload,
    MemoryListResult,
    MemoryTopicEntry,
} from "../lib/memoryPaneTypes";
import { MEMORY_ARCHIVE_PREFIX, MEMORY_ROOT_ID } from "../lib/memoryPaneTypes";
import { formatRelativeTime } from "../lib/relativeTime";

const TOPIC_TYPES = ["user", "feedback", "project", "reference"] as const;
type TopicType = (typeof TOPIC_TYPES)[number];
type TypeFilter = "all" | TopicType;

/** Topics touched inside this window are "recent"; the rest group under "earlier". */
const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

type PaneView = "detail" | "dream";

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
    /** Consolidation controls; absent in hosts that do not expose dream RPCs. */
    dream?: MemoryDreamActions;
}

function lastActivityMs(topic: MemoryTopicEntry): number {
    const parsed = Date.parse(topic.updatedAt ?? topic.createdAt);
    return Number.isFinite(parsed) ? parsed : 0;
}

function topicMatches(topic: MemoryTopicEntry, terms: readonly string[]): boolean {
    if (terms.length === 0) return true;
    const haystack =
        `${topic.name} ${topic.type} ${topic.description} ${topic.content}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
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
        dream,
    } = props;
    const { t } = useT();
    const lng = useUiLanguage();
    const nowMs = useNow();

    const [isEditing, setIsEditing] = useState(false);
    const [draft, setDraft] = useState<string>("");
    const [conflict, setConflict] = useState<MemoryConflictPayload | null>(null);
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
    const [confirmDiscard, setConfirmDiscard] = useState(false);
    const [query, setQuery] = useState("");
    const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
    const [archivedExpanded, setArchivedExpanded] = useState(false);
    const pendingId = data?.dream?.pending?.id;
    // A topic already selected when the pane mounts (e.g. restored from app
    // state) wins over an unapplied preview; otherwise surface the preview so
    // a run started last session is not silently forgotten.
    const [view, setView] = useState<PaneView>(() =>
        selectedId !== MEMORY_ROOT_ID ? "detail" : pendingId ? "dream" : "detail",
    );

    // A preview that arrives after mount (scheduled job, previous session)
    // opens the consolidation view once. Selecting a topic later stays put:
    // the id does not change, so this effect does not re-fire. The ref starts
    // at the mount-time id so a selection restored with the pane is not
    // replaced by a preview that was already there.
    const seenPendingId = useRef(pendingId);
    useEffect(() => {
        if (pendingId && pendingId !== seenPendingId.current) {
            seenPendingId.current = pendingId;
            setView("dream");
        }
    }, [pendingId]);

    const isMemorySelected = selectedId === MEMORY_ROOT_ID;
    const archivedTopics = data?.dream?.archived ?? [];
    const selectedTopic: MemoryTopicEntry | undefined = data?.topics.find(
        (topic) => topic.id === selectedId,
    );
    const selectedArchivedTopic = selectedId.startsWith(MEMORY_ARCHIVE_PREFIX)
        ? archivedTopics.find((topic) => `${MEMORY_ARCHIVE_PREFIX}${topic.id}` === selectedId)
        : undefined;

    const terms = useMemo(() => query.trim().toLowerCase().split(/\s+/).filter(Boolean), [query]);

    const visibleTopics = useMemo(() => {
        const topics = data?.topics ?? [];
        return topics
            .filter((topic) => typeFilter === "all" || topic.type === typeFilter)
            .filter((topic) => topicMatches(topic, terms))
            .sort((a, b) => lastActivityMs(b) - lastActivityMs(a));
    }, [data?.topics, typeFilter, terms]);

    const visibleArchived = useMemo(
        () =>
            archivedTopics
                .filter((topic) => typeFilter === "all" || topic.type === typeFilter)
                .filter((topic) => topicMatches(topic, terms))
                .sort((a, b) => lastActivityMs(b) - lastActivityMs(a)),
        [archivedTopics, typeFilter, terms],
    );

    const groups = useMemo(() => {
        const recent: MemoryTopicEntry[] = [];
        const earlier: MemoryTopicEntry[] = [];
        for (const topic of visibleTopics) {
            const activity = lastActivityMs(topic);
            const isRecent = activity > 0 && nowMs - activity <= RECENT_WINDOW_MS;
            (isRecent ? recent : earlier).push(topic);
        }
        return { recent, earlier };
    }, [visibleTopics, nowMs]);

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

    const isMemoryEmpty =
        data.memoryContent.trim() === "# Memory" &&
        data.topics.length === 0 &&
        archivedTopics.length === 0;
    const showArchived =
        archivedExpanded || terms.length > 0 || selectedArchivedTopic !== undefined;

    const handleSelect = (id: string) => {
        setView("detail");
        onSelect(id);
    };

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

    const handleRestore = async (id: string) => {
        if (!dream) return;
        await dream.onRestoreTopic(id);
        onSelect(MEMORY_ROOT_ID);
        setView("detail");
    };

    const typeLabel = (type: TopicType) => t(`memory.type.${type}`);

    const renderTopicRow = (topic: MemoryTopicEntry, archived: boolean) => {
        const rowId = archived ? `${MEMORY_ARCHIVE_PREFIX}${topic.id}` : topic.id;
        return (
            <button
                key={rowId}
                type="button"
                className={`memory-list-item${selectedId === rowId ? " active" : ""}${
                    archived ? " archived" : ""
                }`}
                onClick={() => handleSelect(rowId)}
            >
                <span className="memory-list-item-name">{topic.name}</span>
                <span className="memory-list-item-desc">
                    {topic.description || t("memory.noDescription")}
                </span>
            </button>
        );
    };

    const lastUpdated = selectedTopic?.updatedAt;
    const archivedLastUpdated = selectedArchivedTopic?.updatedAt;

    return (
        <div className="memory-pane">
            <div className="memory-list">
                {/* Counts cover topics only. The global MEMORY.md row is pinned and
                    never filtered, so including it would report "1/3" on a query
                    that actually matched no topics. */}
                <PaneHeader
                    title={t("memory.title")}
                    count={data.topics.length}
                    shownCount={visibleTopics.length}
                    query={query}
                    onQueryChange={setQuery}
                >
                    {dream ? (
                        <Button
                            size="sm"
                            variant={view === "dream" ? "default" : "ghost"}
                            className="memory-dream-trigger"
                            aria-pressed={view === "dream"}
                            onClick={() => setView(view === "dream" ? "detail" : "dream")}
                        >
                            <Sparkles size={14} aria-hidden="true" />
                            {t("memory.dream.open")}
                            {pendingId ? (
                                <span className="memory-dream-dot" aria-hidden="true" />
                            ) : null}
                        </Button>
                    ) : null}
                    <IconButton
                        onClick={onRefresh}
                        title={t("memory.refresh")}
                        aria-label={t("memory.refresh")}
                        disabled={loading}
                    >
                        <RefreshCw size={14} aria-hidden="true" />
                    </IconButton>
                </PaneHeader>

                <div
                    className="memory-filter-bar"
                    role="toolbar"
                    aria-label={t("memory.typeLabel")}
                >
                    <button
                        type="button"
                        className="memory-filter-chip"
                        aria-pressed={typeFilter === "all"}
                        onClick={() => setTypeFilter("all")}
                    >
                        {t("memory.filter.all")}
                    </button>
                    {TOPIC_TYPES.map((type) => (
                        <button
                            key={type}
                            type="button"
                            className="memory-filter-chip"
                            aria-pressed={typeFilter === type}
                            onClick={() => setTypeFilter(type)}
                        >
                            {typeLabel(type)}
                        </button>
                    ))}
                </div>

                <div className="memory-list-body">
                    <div className="memory-list-section-label">{t("memory.globalLabel")}</div>
                    <button
                        type="button"
                        className={`memory-list-item${
                            isMemorySelected && view === "detail" ? " active" : ""
                        }`}
                        onClick={() => handleSelect(MEMORY_ROOT_ID)}
                    >
                        <span className="memory-list-item-name">{t("memory.globalName")}</span>
                    </button>

                    {visibleTopics.length === 0 ? (
                        <div className="memory-list-empty">
                            {terms.length > 0
                                ? t("pane.noMatch")
                                : data.topics.length > 0
                                  ? t("memory.noMatchFilter")
                                  : t("memory.noTopics")}
                        </div>
                    ) : (
                        <>
                            {groups.recent.length > 0 ? (
                                <>
                                    <div className="memory-list-section-label">
                                        {t("memory.group.recent")}
                                    </div>
                                    {groups.recent.map((topic) => renderTopicRow(topic, false))}
                                </>
                            ) : null}
                            {groups.earlier.length > 0 ? (
                                <>
                                    <div className="memory-list-section-label">
                                        {t("memory.group.earlier")}
                                    </div>
                                    {groups.earlier.map((topic) => renderTopicRow(topic, false))}
                                </>
                            ) : null}
                        </>
                    )}

                    {archivedTopics.length > 0 ? (
                        <div className="memory-archive-section">
                            <button
                                type="button"
                                className="memory-archive-toggle"
                                aria-expanded={showArchived}
                                onClick={() => setArchivedExpanded(!showArchived)}
                            >
                                <ChevronRight
                                    size={12}
                                    aria-hidden="true"
                                    className={`memory-archive-chevron${
                                        showArchived ? " open" : ""
                                    }`}
                                />
                                {t("memory.dream.archivedLabel")}
                                <span className="memory-archive-count">
                                    {visibleArchived.length}
                                </span>
                            </button>
                            {showArchived
                                ? visibleArchived.map((topic) => renderTopicRow(topic, true))
                                : null}
                        </div>
                    ) : null}
                </div>
            </div>

            <div className="memory-detail">
                {view === "dream" && dream ? (
                    <MemoryDreamPanel
                        state={data.dream}
                        scheduled={data.dreamScheduled}
                        topics={data.topics}
                        busy={dream.busy}
                        onRun={dream.onRun}
                        onApply={dream.onApply}
                        onDiscard={dream.onDiscard}
                        onUndo={dream.onUndo}
                        onScheduleToggle={dream.onScheduleToggle}
                        onClose={() => setView("detail")}
                    />
                ) : isMemoryEmpty && !isEditing && !selectedArchivedTopic ? (
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
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={handleCancelEdit}
                                    disabled={saving}
                                >
                                    {t("memory.cancel")}
                                </Button>
                                <Button
                                    size="sm"
                                    variant="primary"
                                    onClick={handleSave}
                                    disabled={saving || draft === data.memoryContent}
                                >
                                    <Save size={14} aria-hidden="true" />
                                    {t("memory.save")}
                                </Button>
                            </div>
                        </div>
                    ) : (
                        <div className="memory-view">
                            <div className="memory-view-header">
                                <h2 className="memory-view-name">{t("memory.globalName")}</h2>
                                <Button size="sm" variant="ghost" onClick={handleStartEdit}>
                                    <Pencil size={14} aria-hidden="true" />
                                    {t("memory.edit")}
                                </Button>
                            </div>
                            <AssistantMarkdown
                                className="md-assistant memory-view-markdown"
                                text={data.memoryContent}
                            />
                        </div>
                    )
                ) : selectedArchivedTopic ? (
                    <div className="memory-view">
                        <div className="memory-view-header">
                            <h2 className="memory-view-name">{selectedArchivedTopic.name}</h2>
                            <span className="memory-type-chip">
                                {typeLabel(selectedArchivedTopic.type)}
                            </span>
                            <span className="memory-type-chip memory-type-chip-muted">
                                {t("memory.dream.archivedBadge")}
                            </span>
                        </div>
                        {selectedArchivedTopic.description ? (
                            <p className="memory-view-desc">{selectedArchivedTopic.description}</p>
                        ) : null}
                        <div className="memory-view-content">{selectedArchivedTopic.content}</div>
                        <div className="memory-view-meta">
                            <code>{selectedArchivedTopic.id}</code>
                            <span className="memory-view-meta-time">
                                <span className="memory-view-meta-label">
                                    {archivedLastUpdated
                                        ? t("memory.updatedLabel")
                                        : t("memory.createdLabel")}
                                </span>
                                <span>
                                    {formatRelativeTime(
                                        archivedLastUpdated ?? selectedArchivedTopic.createdAt,
                                        lng,
                                        nowMs,
                                    )}
                                </span>
                            </span>
                            <span className="memory-view-meta-spacer" />
                            <Button
                                size="sm"
                                variant="default"
                                disabled={!dream || dream.busy !== null}
                                onClick={() => {
                                    void handleRestore(selectedArchivedTopic.id);
                                }}
                            >
                                {dream?.busy === "restore"
                                    ? t("memory.dream.restoring")
                                    : t("memory.dream.restore")}
                            </Button>
                        </div>
                    </div>
                ) : selectedTopic ? (
                    <div className="memory-view">
                        <div className="memory-view-header">
                            <h2 className="memory-view-name">{selectedTopic.name}</h2>
                            <span className="memory-type-chip">
                                {typeLabel(selectedTopic.type)}
                            </span>
                        </div>
                        {selectedTopic.description ? (
                            <p className="memory-view-desc">{selectedTopic.description}</p>
                        ) : null}
                        <div className="memory-view-content">{selectedTopic.content}</div>
                        <div className="memory-view-meta">
                            <code>{selectedTopic.id}</code>
                            <span className="memory-view-meta-time">
                                <span className="memory-view-meta-label">
                                    {lastUpdated
                                        ? t("memory.updatedLabel")
                                        : t("memory.createdLabel")}
                                </span>
                                <span>
                                    {formatRelativeTime(
                                        lastUpdated ?? selectedTopic.createdAt,
                                        lng,
                                        nowMs,
                                    )}
                                </span>
                            </span>
                            <span className="memory-view-meta-spacer" />
                            <Button
                                size="sm"
                                variant="danger"
                                onClick={() => setConfirmDeleteId(selectedTopic.id)}
                            >
                                <Trash size={14} aria-hidden="true" />
                                {t("memory.delete")}
                            </Button>
                        </div>
                    </div>
                ) : (
                    <div className="memory-detail-placeholder">
                        <p>{t("memory.selectHint")}</p>
                    </div>
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
