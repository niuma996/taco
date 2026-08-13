/**
 * ChannelsPane — IM channel binding, status, and conversations.
 *
 * Presentational only: all state and RPC live in useChannelsPane /
 * useConversationsPane. The two tabs (bindings / conversations) are mutually
 * exclusive views of the same pane — adding a third "ActivityRail" icon
 * would have stranded conversations next to unrelated icons (the wrong
 * abstraction: an IM conversation is a peer to a binding, not a peer to a
 * plugin).
 */

import type {
    ChannelState,
    ChannelStatusEntry,
    ChannelsListResult,
    ChannelTypeEntry,
    ImConversationEntry,
} from "@taco-ai/protocol";
import { makeImCwd } from "@taco-ai/protocol";
import { type ReactElement, type ReactNode, useEffect, useRef, useState } from "react";
import { ImPolicyDialog } from "../components/ImPolicyDialog.tsx";
import { Button } from "../components/ui/Button.tsx";
import i18n from "../i18n/index.ts";
import { useT } from "../i18n/useI18n";
import { formatRelativeTime } from "../lib/relativeTime.js";
import type { TacoClient } from "../lib/tacoClientTauri.ts";

/** Status → i18n key. A Record so adding a ChannelState breaks the build. */
const STATE_LABEL_KEY: Record<ChannelState, string> = {
    unbound: "channels.stateUnbound",
    awaiting_scan: "channels.stateAwaitingScan",
    scanned: "channels.stateScanned",
    awaiting_verify_code: "channels.stateAwaitingVerifyCode",
    connecting: "channels.stateConnecting",
    connected: "channels.stateConnected",
    expired: "channels.stateExpired",
    error: "channels.stateError",
};

/** Status → dot modifier. Groups the eight states into three visual buckets. */
const STATE_TONE: Record<ChannelState, "ok" | "pending" | "bad"> = {
    unbound: "pending",
    awaiting_scan: "pending",
    scanned: "pending",
    awaiting_verify_code: "pending",
    connecting: "pending",
    connected: "ok",
    expired: "bad",
    error: "bad",
};

type Tab = "bindings" | "conversations";

export interface ChannelsPaneProps {
    client: TacoClient;
    // ── bindings tab ──
    status: ChannelsListResult | null;
    loading: boolean;
    error: string | null;
    savingId: string | null;
    pendingRestart: boolean;
    restarting: boolean;
    onCreate: (name: string) => void;
    onRestart: () => void;
    onBind: (channelId: string) => void;
    onRebind: (channelId: string) => void;
    onUnbind: (channelId: string) => void;

    // ── conversations tab ──
    conversations: ImConversationEntry[] | null;
    conversationsLoading: boolean;
    conversationsError: string | null;
    conversationsUnread: number;
    onOpenConversation: (cwd: string, sessionId: string) => void;
    /** Active workspace cwd — used to dedupe the badge (don't count the
     *  conversation the user is already viewing as unread). */
    activeCwd: string | undefined;
    /** Called by the pane on tab switch so the unread counter resets. */
    markConversationsSeen: () => void;
}

export function ChannelsPane(props: ChannelsPaneProps): ReactElement {
    const {
        client,
        status,
        loading,
        error,
        savingId,
        pendingRestart,
        restarting,
        onCreate,
        onRestart,
        onBind,
        onRebind,
        onUnbind,
        conversations,
        conversationsLoading,
        conversationsError,
        conversationsUnread,
        onOpenConversation,
        activeCwd,
        markConversationsSeen,
    } = props;
    const { t } = useT();
    const [tab, setTab] = useState<Tab>("bindings");
    /** Scope for the policy dialog. `peerId`+`chatId` selects chat-override
     *  mode; channelId-only selects channel-default mode. */
    const [policyScope, setPolicyScope] = useState<{
        channelId: string;
        peerId?: string;
        chatId?: string;
    } | null>(null);
    // markConversationsSeen closes over the conversations array — depending
    // on its identity directly would re-fire on every push and clobber the
    // snapshot. A ref keeps the latest callable without putting it in deps.
    const markSeenRef = useRef<() => void>(() => {});
    markSeenRef.current = markConversationsSeen;

    // Resetting the unread counter when the user lands on the tab is the
    // hook's responsibility (markConversationsSeen) — but the pane must
    // call it on tab change so we don't double-count events that arrive
    // while the tab is already open.
    useEffect(() => {
        if (tab === "conversations") {
            markSeenRef.current();
        }
    }, [tab]);

    // An instance already declared cannot be added twice.
    const configuredNames = new Set(status?.configured.map((c) => c.name) ?? []);

    return (
        <div className="channels-pane">
            <div className="pane-header">
                <span>{t("channels.title")}</span>
                <span className="pane-subtitle">{t("channels.subtitle")}</span>
            </div>

            <div className="channels-tabs" role="tablist">
                <button
                    type="button"
                    role="tab"
                    aria-selected={tab === "bindings"}
                    className={`channels-tab ${tab === "bindings" ? "channels-tab--active" : ""}`}
                    onClick={() => setTab("bindings")}
                >
                    {t("channels.tabBindings")}
                </button>
                <button
                    type="button"
                    role="tab"
                    aria-selected={tab === "conversations"}
                    className={`channels-tab ${tab === "conversations" ? "channels-tab--active" : ""}`}
                    onClick={() => setTab("conversations")}
                >
                    {t("channels.tabConversations")}
                    {conversationsUnread > 0 && (
                        <span
                            className="channels-tab-badge"
                            aria-label={t("channels.unreadAria", { count: conversationsUnread })}
                        >
                            {conversationsUnread}
                        </span>
                    )}
                </button>
            </div>

            {tab === "bindings" ? (
                <BindingsTab
                    status={status}
                    loading={loading}
                    error={error}
                    savingId={savingId}
                    pendingRestart={pendingRestart}
                    restarting={restarting}
                    onCreate={onCreate}
                    onRestart={onRestart}
                    onBind={onBind}
                    onRebind={onRebind}
                    onUnbind={onUnbind}
                    configuredNames={configuredNames}
                    onOpenPolicy={(channelId) => setPolicyScope({ channelId })}
                    t={t}
                />
            ) : (
                <ConversationsTab
                    conversations={conversations}
                    loading={conversationsLoading}
                    error={conversationsError}
                    onOpenConversation={onOpenConversation}
                    activeCwd={activeCwd}
                    onOpenPolicy={(entry) =>
                        setPolicyScope({
                            channelId: entry.channelId,
                            peerId: entry.peerId,
                            chatId: entry.chatId,
                        })
                    }
                    t={t}
                />
            )}

            <ImPolicyDialog
                open={policyScope !== null}
                scope={policyScope}
                client={client}
                onClose={() => setPolicyScope(null)}
            />
        </div>
    );
}

function BindingsTab(props: {
    status: ChannelsListResult | null;
    loading: boolean;
    error: string | null;
    savingId: string | null;
    pendingRestart: boolean;
    restarting: boolean;
    onCreate: (name: string) => void;
    onRestart: () => void;
    onBind: (channelId: string) => void;
    onRebind: (channelId: string) => void;
    onUnbind: (channelId: string) => void;
    onOpenPolicy: (channelId: string) => void;
    configuredNames: Set<string>;
    t: (k: string) => string;
}): ReactElement {
    const {
        status,
        loading,
        error,
        savingId,
        pendingRestart,
        restarting,
        onCreate,
        onRestart,
        onBind,
        onRebind,
        onUnbind,
        onOpenPolicy,
        configuredNames,
        t,
    } = props;
    return (
        <>
            <div className="pane-config-hint">{t("channels.configHint")}</div>

            {pendingRestart && (
                <div className="pane-restart-banner">
                    <span>{t("channels.pendingRestart")}</span>
                    <Button size="sm" variant="primary" disabled={restarting} onClick={onRestart}>
                        {restarting ? t("channels.restarting") : t("channels.restart")}
                    </Button>
                </div>
            )}

            {error && <div className="error-banner">{error}</div>}
            {loading && <div className="pane-loading">{t("channels.loading")}</div>}

            {status && (
                <div className="channels-sections">
                    <ChannelSection
                        title={t("channels.sectionConfigured")}
                        empty={status.configured.length === 0}
                        emptyText={t("channels.emptyConfigured")}
                    >
                        {status.configured.map((entry) => (
                            <ConfiguredCard
                                key={entry.channelId}
                                entry={entry}
                                saving={savingId === entry.channelId}
                                onBind={() => onBind(entry.channelId)}
                                onRebind={() => onRebind(entry.channelId)}
                                onUnbind={() => onUnbind(entry.channelId)}
                                onOpenPolicy={() => onOpenPolicy(entry.channelId)}
                                t={t}
                            />
                        ))}
                    </ChannelSection>

                    <ChannelSection
                        title={t("channels.sectionAvailable")}
                        empty={status.available.length === 0}
                        emptyText={t("channels.emptyAvailable")}
                    >
                        {status.available.map((type) => (
                            <AvailableCard
                                key={type.name}
                                type={type}
                                added={configuredNames.has(type.name)}
                                saving={savingId === type.name}
                                onCreate={() => onCreate(type.name)}
                                t={t}
                            />
                        ))}
                    </ChannelSection>

                    {status.failed.length > 0 && (
                        <ChannelSection
                            title={t("channels.sectionFailed")}
                            empty={false}
                            emptyText=""
                        >
                            {status.failed.map((f) => (
                                <div key={f.channelId} className="pane-card channels-card-bad">
                                    <span className="pane-card-name">{f.channelId}</span>
                                    <span className="channels-card-error">{f.error}</span>
                                </div>
                            ))}
                        </ChannelSection>
                    )}
                </div>
            )}
        </>
    );
}

function ConversationsTab(props: {
    conversations: ImConversationEntry[] | null;
    loading: boolean;
    error: string | null;
    onOpenConversation: (cwd: string, sessionId: string) => void;
    activeCwd: string | undefined;
    onOpenPolicy: (entry: ImConversationEntry) => void;
    t: (k: string) => string;
}): ReactElement {
    const { conversations, loading, error, onOpenConversation, activeCwd, onOpenPolicy, t } = props;

    if (error) {
        return <div className="error-banner">{error}</div>;
    }
    if (loading && !conversations) {
        return <div className="pane-loading">{t("channels.loading")}</div>;
    }
    if (!conversations || conversations.length === 0) {
        return (
            <div className="channels-section">
                <p className="pane-empty">{t("channels.emptyConversations")}</p>
            </div>
        );
    }

    return (
        <div className="channels-sections">
            <ChannelSection title={t("channels.sectionConversations")} empty={false} emptyText="">
                {conversations.map((c) => (
                    <ConversationRow
                        key={c.sessionId}
                        entry={c}
                        // A conversation is "currently being read" only when
                        // it is the active workspace — a session attached in
                        // another workspace should still count as unread so
                        // the user notices it on return.
                        isActive={activeCwd === makeImCwd(c.channelId, c.peerId, c.chatId)}
                        onOpen={() =>
                            onOpenConversation(
                                makeImCwd(c.channelId, c.peerId, c.chatId),
                                c.sessionId,
                            )
                        }
                        onOpenPolicy={() => onOpenPolicy(c)}
                    />
                ))}
            </ChannelSection>
        </div>
    );
}

function ChannelSection(props: {
    title: string;
    empty: boolean;
    emptyText: string;
    children: ReactNode;
}): ReactElement {
    const { title, empty, emptyText, children } = props;
    return (
        <section className="channels-section">
            <h3 className="pane-section-title">{title}</h3>
            {empty ? <p className="pane-empty">{emptyText}</p> : children}
        </section>
    );
}

function ConfiguredCard(props: {
    entry: ChannelStatusEntry;
    saving: boolean;
    onBind: () => void;
    onRebind: () => void;
    onUnbind: () => void;
    onOpenPolicy: () => void;
    t: (k: string) => string;
}): ReactElement {
    const { entry, saving, onBind, onRebind, onUnbind, onOpenPolicy, t } = props;
    const tone = STATE_TONE[entry.state];
    const isConnected = entry.state === "connected";

    return (
        <div className="pane-card">
            <div className="pane-card-header">
                <span className="pane-card-name">{entry.name}</span>
                <span
                    className={`channels-status channels-status--${tone}`}
                    // Binding transitions arrive as pushes rather than from a
                    // user action, so announce them.
                    aria-live="polite"
                >
                    <span className="channels-status-dot" aria-hidden="true" />
                    {t(STATE_LABEL_KEY[entry.state])}
                </span>
                <div className="channels-card-actions">
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={onOpenPolicy}
                        // Editing policy on an unconfigured channel is empty
                        // work — the dialog would just show the built-in default.
                        // Allow access on every configured state (connected /
                        // error / verifying) so admins can fix a broken binding.
                        disabled={!entry.configured}
                    >
                        {t("imPolicy.openChannel")}
                    </Button>
                    {isConnected ? (
                        <>
                            <Button size="sm" disabled={saving} onClick={onRebind}>
                                {t("channels.rebind")}
                            </Button>
                            <Button size="sm" variant="danger" disabled={saving} onClick={onUnbind}>
                                {t("channels.unbind")}
                            </Button>
                        </>
                    ) : (
                        <Button size="sm" variant="primary" disabled={saving} onClick={onBind}>
                            {t("channels.bind")}
                        </Button>
                    )}
                </div>
            </div>
            {entry.message && <p className="pane-card-message">{entry.message}</p>}
        </div>
    );
}

function AvailableCard(props: {
    type: ChannelTypeEntry;
    added: boolean;
    saving: boolean;
    onCreate: () => void;
    t: (k: string) => string;
}): ReactElement {
    const { type, added, saving, onCreate, t } = props;
    return (
        <div className="pane-card">
            <div className="pane-card-header">
                <span className="pane-card-name">{type.name}</span>
                <span className="pane-card-version">v{type.version}</span>
                <div className="channels-card-actions">
                    {added ? (
                        <span className="channels-card-added">{t("channels.added")}</span>
                    ) : (
                        <Button size="sm" variant="primary" disabled={saving} onClick={onCreate}>
                            {t("channels.add")}
                        </Button>
                    )}
                </div>
            </div>
            <p className="pane-card-desc">{type.description ?? t("channels.noDescription")}</p>
        </div>
    );
}

function ConversationRow(props: {
    entry: ImConversationEntry;
    isActive: boolean;
    onOpen: () => void;
    onOpenPolicy: () => void;
}): ReactElement {
    const { entry, isActive, onOpen, onOpenPolicy } = props;
    const { t } = useT();
    return (
        <div className={`channels-conv-row ${isActive ? "channels-conv-row--active" : ""}`}>
            <button
                type="button"
                className="channels-conv-row-main"
                onClick={onOpen}
                aria-label={entry.peerId}
            >
                <span className="channels-conv-row-peer" title={entry.peerId}>
                    {entry.peerId}
                </span>
                <span className="channels-conv-row-channel">{entry.channelId}</span>
                <span className="channels-conv-row-time">
                    {formatRelativeTime(
                        new Date(entry.lastUsedAt).toISOString(),
                        i18n.language,
                        Date.now(),
                    )}
                </span>
            </button>
            <Button size="sm" variant="ghost" onClick={onOpenPolicy}>
                {t("imPolicy.openChat")}
            </Button>
        </div>
    );
}
