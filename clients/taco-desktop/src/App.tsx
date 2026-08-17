/**
 * App shell — assembles workspace/session state (useWorkspaces), sidecar push
 * routing (useSidecarStream), five secondary pane hooks (tools/skills/agents/
 * plugins/memory), ChatPane UI state (useChatInputState), and the cross-pane
 * restartSidecar shared by Settings + Plugins. Layout + top-level view
 * switching only; per-pane domain logic lives in the hooks.
 */

import type { ChannelStatusEntry, CommandPermissionScope } from "@taco-ai/protocol";
import { IM_CWD_PREFIX } from "@taco-ai/protocol";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { Plus } from "lucide-react";

import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityRail } from "./components/ActivityRail";
import { ChannelBindDialog } from "./components/ChannelBindDialog";
import { ConfirmModal } from "./components/ConfirmModal";
import { FilesDrawer } from "./components/FilesDrawer";
import { LlmDumpChip, LlmDumpPanel } from "./components/LlmDumpPanel";
import { OnboardingModal } from "./components/onboarding/OnboardingModal.js";
import { PlanModeIndicator } from "./components/panels/PlanModeIndicator";
import { TaskPanel } from "./components/panels/TaskPanel";
import { RenameModal } from "./components/RenameModal";
import { McpSection } from "./components/settings/McpSection.tsx";
import { UpdateDialog } from "./components/UpdateDialog";
import { WindowControls } from "./components/WindowControls";
import { WorkspacePicker } from "./components/WorkspacePicker";
import { useAgentsPane } from "./hooks/useAgentsPane";
import { AskUserProvider } from "./hooks/useAskUser";
import { useChannelsPane } from "./hooks/useChannelsPane";
import { useChatInputState } from "./hooks/useChatInputState";
import { useCheckpointsPane } from "./hooks/useCheckpointsPane";
import { useConversationsPane } from "./hooks/useConversationsPane";
import { useFilesDrawer } from "./hooks/useFilesDrawer";
import { useLlmDump } from "./hooks/useLlmDump";
import { useMemoryPane } from "./hooks/useMemoryPane";
import { usePluginsPane } from "./hooks/usePluginsPane";
import { useProviders } from "./hooks/useProviders";
import { useSessionContextInfo } from "./hooks/useSessionContextInfo";
import { sidecarLogListenerReady, useSidecarStream } from "./hooks/useSidecarStream";
import { useSkillsPane } from "./hooks/useSkillsPane";
import { SubagentProvider } from "./hooks/useSubagent";
import { useTheme } from "./hooks/useTheme";
import { useToast } from "./hooks/useToast";
import { useToolsPane } from "./hooks/useToolsPane";
import { useWorkspaceModels } from "./hooks/useWorkspaceModels";
import { useWorkspaces } from "./hooks/useWorkspaces";
import { useT } from "./i18n/useI18n";
import { readClientSettings } from "./lib/clientSettings";
import {
    type DesktopConfig,
    isOnboardingRequired,
    type OnboardingStatus,
    readDesktopConfig,
} from "./lib/desktopConfig.js";
import {
    defaultModelForNewSession,
    getGlobalConfig,
    loadGlobalConfig,
    subscribeGlobalConfig,
} from "./lib/globalConfig";
import { onImPolicyChangedEvent } from "./lib/imPolicyEvents.ts";
import { TacoClient } from "./lib/tacoClientTauri.ts";
import { checkForUpdate } from "./lib/updater.ts";
import { getDefaultCwd } from "./lib/workspaceStorage.js";
import { AgentsPane } from "./views/AgentsPane";
import { ChannelsPane } from "./views/ChannelsPane";
import { ChatPane } from "./views/ChatPane";
import { CheckpointsPane } from "./views/CheckpointsPane";
import { MemoryPane } from "./views/MemoryPane";
import { PluginsPane } from "./views/PluginsPane";
import { SettingsPane } from "./views/SettingsPane";
import { Sidebar } from "./views/Sidebar";
import { SkillsPane } from "./views/SkillsPane";
import { ToolsPane } from "./views/ToolsPane";

export default function App() {
    const [client] = useState(() => new TacoClient());
    const [desktopConfig, setDesktopConfig] = useState<DesktopConfig | null>(null);
    const wsApi = useWorkspaces(client);
    const filesDrawer = useFilesDrawer();
    useTheme();
    const { t } = useT();
    const { show: showToast } = useToast();
    const {
        workspaces,
        activeCwd,
        activeWs: ws,
        activeModel,
        activeLevel,
        errorBanner,
        dispatch,
        dispatchWs,
        setErrorBanner,
        initFromStorage,
        reloadAllWorkspaces,
        loadMoreSessions,
        switchWorkspace,
        browseAndOpen,
        attachSession,
        deleteSession,
        renameSession,
        beginPendingNewSession,
        openImConversation,
        sendPrompt,
        abortPrompt,
        setSessionModel,
        setSessionLevel,
        loadSubagentHistory,
    } = wsApi;

    const activeSid = ws?.activeSession;
    const contextInfo = useSessionContextInfo(client, activeCwd, activeSid);

    // Compaction-finished push → toast + refresh ratio + clear one-shot state.
    // See useSessionContextInfo.lastCompactionFinished.
    const lastReportedCompactionIdRef = useRef<number | undefined>(undefined);
    useEffect(() => {
        const tagged = contextInfo.lastCompactionFinished;
        if (!tagged) return;
        if (lastReportedCompactionIdRef.current === tagged.id) return;
        lastReportedCompactionIdRef.current = tagged.id;

        const finished = tagged.result;
        const seconds = (finished.durationMs / 1000).toFixed(1);
        if (finished.failed) {
            // Prefer the localized copy keyed off `reason`; `failureMessage` is
            // English-only diagnostic text and only appears when there is no
            // classified reason to render instead.
            const REASON_KEYS: Record<string, string> = {
                aborted: "context.compactFailedAborted",
                timeout: "context.compactFailedTimeout",
                cancelled: "context.compactFailedCancelled",
                busy: "context.compactFailedBusy",
                nothing: "context.compactFailedNothing",
            };
            const reasonKey = finished.reason ? REASON_KEYS[finished.reason] : undefined;
            const headline = reasonKey ? t(reasonKey) : t("context.compactFailed");
            const detail =
                !reasonKey && finished.failureMessage ? `: ${finished.failureMessage}` : "";
            showToast(`❌ ${headline}${detail} (${seconds}s)`, "error");
        } else {
            showToast(
                `${t("context.compactDone")} · ${(finished.summaryChars / 1).toString().replace(/(\d)(?=(\d{3})+$)/g, "$1,")} chars · ${seconds}s`,
            );
        }
        void contextInfo.refresh();
        contextInfo.clearCompactionToast();
    }, [
        contextInfo.lastCompactionFinished,
        showToast,
        t,
        contextInfo.refresh,
        contextInfo.clearCompactionToast,
    ]);

    // Entering an IM workspace → one-shot warning toast that the reply goes
    // straight to WeChat. Floating, not a banner — it must not eat chat layout.
    const lastImPeerRef = useRef<string | null>(null);
    useEffect(() => {
        if (!activeCwd?.startsWith(IM_CWD_PREFIX)) {
            lastImPeerRef.current = null;
            return;
        }
        const peer = decodeURIComponent(activeCwd.split("/")[3] ?? "") || activeCwd;
        // Same peer re-attaches (e.g. sidebar re-click) should not re-fire.
        if (lastImPeerRef.current === peer) return;
        lastImPeerRef.current = peer;
        showToast(t("channels.imBanner", { peer }), "warn");
    }, [activeCwd, showToast, t]);

    // sidecar push routing: normalize + dedup → reducer action
    const llmDump = useLlmDump();
    const { options: modelOptions, refresh: refreshModels } = useWorkspaceModels(
        client,
        activeCwd || null,
        Boolean(ws),
    );
    // Picker only offers models from providers with a configured key —
    // useProviders supplies the configured flag, key changes trigger a refresh.
    const { providers, refresh: refreshProviders } = useProviders(
        client,
        activeCwd || null,
        Boolean(ws),
    );
    const configuredProviderIds = new Set(providers.filter((p) => p.configured).map((p) => p.id));
    const filteredOptions = modelOptions.filter((o) => configuredProviderIds.has(o.provider));
    // Key change → refresh both models (available set) and providers (configured flag).
    // Triggered by ProviderSection.onKeysChanged → onRefreshModels.
    const refreshAfterKeyChange = () => {
        refreshModels();
        refreshProviders();
    };

    // Timing fix: models and providers fetch in parallel with no ordering.
    // On cold start, if models returns before providers (or listModels silently
    // fails), filteredOptions stays empty and neither hook auto-refetches.
    // Pull models once when the configured-provider set transitions empty → non-empty.
    const hadConfiguredRef = useRef(false);
    useEffect(() => {
        const hasConfigured = configuredProviderIds.size > 0;
        if (hasConfigured && !hadConfiguredRef.current) {
            refreshModels();
        }
        hadConfiguredRef.current = hasConfigured;
    });

    // Subscribe to globalConfig so Settings drawer changes propagate to the picker
    // immediately (without a hard reload).
    const [globalConfigState, setGlobalConfigState] = useState(() => getGlobalConfig());
    useEffect(() => subscribeGlobalConfig(setGlobalConfigState), []);

    const [mainView, setMainView] = useState<
        | "chat"
        | "tools"
        | "skills"
        | "agents"
        | "plugins"
        | "channels"
        | "memory"
        | "checkpoints"
        | "mcp"
        | "settings"
    >("chat");
    // Sidebar collapse state — collapsed sidebar shrinks to a rail with only the
    // expand button, letting ChatPane fill the main area. Chat view only.
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

    // Fallback chain mirrors activeLevel:
    //   1. per-session override (already shown)
    //   2. global default from settings (TacoGlobalConfigShape.defaultModel)
    //   3. first catalog option (last-resort)
    //   4. null (no options loaded yet, no default, no session)
    const defaultModel = defaultModelForNewSession(globalConfigState.global);
    const activeModelWithFallback =
        activeModel ??
        (defaultModel ? { provider: defaultModel.provider, id: defaultModel.id } : null) ??
        filteredOptions[0] ??
        null;

    /** Set once useChannelsPane is initialized; see onChannelStatusChanged below. */
    const applyChannelStatusRef = useRef<((channel: ChannelStatusEntry) => void) | null>(null);
    // Same indirection for conversations — see comment on onConversationsChanged.
    const onConversationsChangedRef = useRef<(() => void) | null>(null);
    // `im.policy_changed` reaches every open ImPolicyDialog through a
    // module-scoped emitter (src/lib/imPolicyEvents.ts) rather than a ref —
    // dialogs are mounted deep in ChannelsPane and the ref indirection would
    // still need lifecycle plumbing to wire/unwire the listener.

    const { clearCursors } = useSidecarStream(client, {
        onAction: dispatch,
        onSnapshotRequired: wsApi.restoreSessionSnapshot,
        onLogLine: setErrorBanner,
        // Warns are degradations, not failures — a transient toast instead of
        // the persistent banner, so they don't interrupt what the user is doing.
        onWarningLine: (line) => showToast(line, "warn"),
        onLlmDumpLine: llmDump.push,
        onModelsChanged: (cwd) => {
            // Only refresh if the push is for the currently active workspace —
            // other workspaces' menus will re-pull on next activation.
            if (cwd === activeCwd) {
                refreshModels();
                refreshProviders();
            }
        },
        // Indirected through a ref: useChannelsPane is declared further down,
        // so naming applyChannelStatus here would read it before init.
        onChannelStatusChanged: (channel) => applyChannelStatusRef.current?.(channel),
        onConversationsChanged: () => onConversationsChangedRef.current?.(),
        onImPolicyChanged: (channelId) => onImPolicyChangedEvent(channelId),
        // The ImPolicyDialog confirms before saving, so no active warning is
        // needed here; reserved for a future desktop notice.
        onImWorkspacesInvalidated: (_channelId) => {},
    });

    // Run once on mount.
    useEffect(() => {
        void initFromStorage();
    }, [initFromStorage]);

    // Load desktop-only config for onboarding gate (global config already loaded by initFromStorage).
    useEffect(() => {
        readDesktopConfig()
            .then(setDesktopConfig)
            .catch((err) => {
                console.error("[taco] failed to load desktop config", err);
                setDesktopConfig({});
            });
    }, []);

    // Silent auto-check on mount. Populates updateStatus so the
    // Settings activity-rail entry can show a badge and the Updates
    // tab can render status text — but does NOT auto-open the dialog.
    // The user clicks the Settings rail (or the Check now button) to
    // act. Skipped in dev because the manifest endpoint 404s and
    // hot-reload would otherwise spam GitHub's API.
    const [updateStatus, setUpdateStatus] = useState<{
        checking: boolean;
        available: { version: string } | null;
        error: string | null;
    }>({ checking: false, available: null, error: null });
    const [updateDialog, setUpdateDialog] = useState<{ open: boolean; version?: string }>({
        open: false,
    });
    // Manual check: always runs. The Check now button needs to work in
    // dev too so the Updates tab is actually demoable — without it the
    // button would be a no-op whenever import.meta.env.DEV is true.
    const runUpdateCheck = useCallback(() => {
        setUpdateStatus((s) => ({ ...s, checking: true, error: null }));
        void (async () => {
            const status = await checkForUpdate();
            if (status.state === "available" && status.version) {
                setUpdateStatus({
                    checking: false,
                    available: { version: status.version },
                    error: null,
                });
                setUpdateDialog({ open: true, version: status.version });
            } else if (status.state === "error") {
                setUpdateStatus({
                    checking: false,
                    available: null,
                    error: status.error ?? "unknown error",
                });
            } else {
                setUpdateStatus({ checking: false, available: null, error: null });
            }
        })();
    }, []);

    // Silent mount-time auto-check. Guarded by import.meta.env.DEV so
    // hot-reload doesn't spam GitHub's API on every code edit.
    useEffect(() => {
        if (import.meta.env.DEV) return;
        runUpdateCheck();
    }, [runUpdateCheck]);
    // Accumulate FS scope entries for each newly activated workspace.
    // Scope grows per activeCwd; tauri-plugin-fs 2.x never revokes paths.
    useEffect(() => {
        if (!activeCwd) return;
        void tauriInvoke("set_fs_scope", { path: activeCwd }).catch((e: unknown) => {
            console.warn("[taco] set_fs_scope failed:", e);
        });
    }, [activeCwd]);

    // Task snapshot clearing on session switch is done synchronously in
    // attachSessionInternal (no React effect, no race with first push).

    // Chat input + modal orchestration lives in its own hook (eight sibling
    // useStates that don't interact with each other; bundling keeps App.tsx
    // from re-accreting a useState every time someone adds a chip or modal).
    const {
        copiedSessionId,
        setCopiedSessionId,
        input,
        setInput,
        attachments,
        setAttachments,
        confirmNewSession,
        setConfirmNewSession,
        pendingNewSessionCwd,
        setPendingNewSessionCwd,
        pendingDeleteSession,
        setPendingDeleteSession,
        pendingRenameSession,
        setPendingRenameSession,
        llmDumpOpen,
        setLlmDumpOpen,
    } = useChatInputState();
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    function autoResizeTextarea() {
        const el = textareaRef.current;
        if (!el) return;
        el.style.height = "auto";
        el.style.height = `${el.scrollHeight}px`;
    }

    // DebugTab restart: dispose → restart all workspaces so sidecar picks up the
    // new debugMode (TACO_DEBUG_LLM_PAYLOAD). Clear cursors first — new sidecar
    // resets session seq to 1, so stale cursors would drop new frames as dupes.
    // Reload settings + global config + workspaces after: dispose() clears
    // ensuredCwds, and old attached session IDs are stale in the new process.
    const restartSidecar = async (): Promise<void> => {
        const cwds = Object.keys(workspaces);
        // debugMode / llmDumpToFile read sync localStorage to avoid depending on
        // cache.client (may not have loadGlobalConfig yet).
        const settings = readClientSettings();
        await client.dispose();
        clearCursors();
        // The listener is the same one we set up at mount; awaiting it here
        // is a cheap re-check that it's still up (re-resolves immediately)
        // so the restarted sidecar's first lines aren't lost to a torn-down
        // listener that React is still reattaching.
        await sidecarLogListenerReady;
        await Promise.all(
            cwds.map((cwd) =>
                client.start(cwd, {
                    debugMode: settings.debugMode,
                    llmDumpToFile: settings.llmDumpToFile,
                }),
            ),
        );
        try {
            await loadGlobalConfig(client);
        } catch (e) {
            console.error("[taco] loadGlobalConfig failed (restart)", e);
        }
        await reloadAllWorkspaces();
        llmDump.clear();
        showToast(t("settings.debugModeToast"));
    };

    // Secondary pane state + domain logic live in dedicated hooks. Each hook
    // gates its fetch on `mainView === "<view>"` so inactive panes stay idle.
    const { tools } = useToolsPane(client, mainView === "tools", activeCwd);
    const {
        skills,
        selectedSkillName,
        setSelectedSkillName,
        skillContent,
        skillContentLoading,
        skillContentError,
    } = useSkillsPane(client, mainView === "skills", activeCwd);
    const {
        agents,
        selectedAgentType,
        setSelectedAgentType,
        agentContent,
        agentContentLoading,
        agentContentError,
    } = useAgentsPane(client, mainView === "agents", activeCwd);
    const {
        extensionStatus,
        extensionLoading,
        extensionError,
        extensionSavingName,
        extensionPendingRestart,
        extensionRestarting,
        toggleExtension,
        restartForPlugins,
    } = usePluginsPane(client, mainView === "plugins", activeCwd, restartSidecar);
    const {
        channelsStatus,
        channelsLoading,
        channelsError,
        channelsSavingId,
        bindChannel,
        unbindChannel,
        submitVerifyCode,
        createChannel,
        channelsPendingRestart,
        channelsRestarting,
        restartForChannels,
        applyChannelStatus,
    } = useChannelsPane(client, mainView === "channels", activeCwd, restartSidecar);
    applyChannelStatusRef.current = applyChannelStatus;
    const {
        conversations,
        loading: conversationsLoading,
        error: conversationsError,
        unreadCount: conversationsUnread,
        onConversationsChanged,
        markConversationsSeen,
    } = useConversationsPane(client, mainView === "channels", activeCwd);
    onConversationsChangedRef.current = onConversationsChanged;
    /** channelId whose bind dialog is open; null closes it. */
    const [bindingChannelId, setBindingChannelId] = useState<string | null>(null);
    const {
        memoryData,
        memoryLoading,
        memoryError,
        memorySelectedId,
        setMemorySelectedId,
        memorySaving,
        loadMemory,
        handleSaveMemory,
        handleDeleteTopic,
    } = useMemoryPane(client, mainView === "memory", activeCwd, t, showToast);

    const checkpoints = useCheckpointsPane(
        client,
        mainView === "checkpoints",
        activeCwd,
        activeSid,
        showToast,
    );

    // Chat auto-scroll lives in ChatPane: observer + scroll listener lifecycles
    // follow ChatPane mount/unmount. App never unmounts and <main> is swapped by
    // conditional render, so the logic can't live here.

    async function copySessionId(sessionId: string): Promise<void> {
        try {
            await navigator.clipboard.writeText(sessionId);
            setCopiedSessionId(sessionId);
            window.setTimeout(() => {
                setCopiedSessionId((cur) => (cur === sessionId ? null : cur));
            }, 1200);
        } catch (err) {
            console.error("[taco] copy session id failed", err);
            setErrorBanner(`Copy failed: ${(err as Error).message}`);
        }
    }

    return (
        <div className="app-shell">
            {/* Custom window controls — only used when the OS draws none. On
               macOS we use the native overlay title bar (rounded corners +
               native traffic lights), so the custom component must not
               render there; on Windows/Linux the window is frameless
               (decorations:false) and this provides min/max/close. */}
            {document.documentElement.dataset.platform !== "macos" && <WindowControls />}
            <ActivityRail
                activeView={mainView}
                onSelect={setMainView}
                hasUpdateBadge={updateStatus.available !== null}
            />
            <div className="app-main">
                <header className="topbar" data-tauri-drag-region>
                    <div className="topbar-picker-group">
                        <WorkspacePicker
                            workspaces={Object.values(workspaces)
                                .filter((w) => !w.cwd.startsWith(IM_CWD_PREFIX))
                                .map((w) => ({ cwd: w.cwd }))}
                            activeCwd={activeCwd}
                            onChange={(cwd) => void switchWorkspace(cwd)}
                            onOpenFolder={() => void browseAndOpen()}
                        />
                        <button
                            type="button"
                            className="topbar-new-session"
                            onClick={() => {
                                // Lazy creation: the new session id is allocated by the
                                // server on the first real send, not here. Only confirm
                                // when there's unsent content to discard.
                                if (input.trim() !== "" || attachments.length > 0) {
                                    setPendingNewSessionCwd(activeCwd);
                                    setConfirmNewSession(true);
                                    return;
                                }
                                beginPendingNewSession(activeCwd);
                                setInput("");
                                setAttachments([]);
                            }}
                            disabled={!ws || Boolean(activeCwd?.startsWith(IM_CWD_PREFIX))}
                            title={t("session.newInWorkspace")}
                            aria-label={t("session.newInWorkspace")}
                        >
                            <Plus size={15} aria-hidden="true" />
                            <span>{t("session.new")}</span>
                        </button>
                    </div>
                    {llmDump.entries.length > 0 && (
                        <LlmDumpChip
                            count={llmDump.entries.length}
                            onClick={() => setLlmDumpOpen(true)}
                        />
                    )}
                    {/* ContextIndicator moved to ChatPane input-controls */}
                    {activeCwd && activeSid && (
                        <PlanModeIndicator
                            cwd={activeCwd}
                            sid={activeSid}
                            workspaces={workspaces}
                        />
                    )}
                    <div className="drag-spacer" data-tauri-drag-region />
                    {errorBanner && (
                        <div
                            className="error-banner"
                            role="alert"
                            onClick={() => setErrorBanner(null)}
                            title={t("copy.clickToDismiss")}
                        >
                            {errorBanner}
                        </div>
                    )}
                </header>
                <div className="layout">
                    {mainView === "chat" ? (
                        <>
                            {!sidebarCollapsed && (
                                <Sidebar
                                    ws={ws}
                                    onAttach={async (sid) => {
                                        try {
                                            await attachSession(activeCwd, sid);
                                        } catch (err) {
                                            setErrorBanner(
                                                `Cannot open session: ${(err as Error).message}`,
                                            );
                                        }
                                    }}
                                    onDelete={(sid) =>
                                        setPendingDeleteSession({ cwd: activeCwd, sessionId: sid })
                                    }
                                    onRename={(sid) => {
                                        const current = ws?.sessions.find((s) => s.id === sid);
                                        setPendingRenameSession({
                                            cwd: activeCwd,
                                            sessionId: sid,
                                            currentName: current?.name ?? "",
                                        });
                                    }}
                                    onLoadMore={() => {
                                        void loadMoreSessions(activeCwd);
                                    }}
                                />
                            )}
                            <SubagentProvider
                                cwd={activeCwd}
                                loadSubagentHistory={loadSubagentHistory}
                                liveMessagesFor={(subSessionId) =>
                                    ws?.childMessagesBySubSessionId?.[subSessionId] ?? []
                                }
                                historyMessagesFor={(subSessionId) =>
                                    ws?.childHistoryLoaded?.[subSessionId] ?? []
                                }
                            >
                                <AskUserProvider
                                    dispatchAskUser={dispatch}
                                    setAskUserAnswers={wsApi.setAskUserAnswers}
                                >
                                    <ChatPane
                                        ws={ws}
                                        sidebarCollapsed={sidebarCollapsed}
                                        onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
                                        input={input}
                                        attachments={attachments}
                                        pending={
                                            Boolean(
                                                ws?.activeSession
                                                    ? ws.pendingBySessionId[ws.activeSession]
                                                    : false,
                                            ) || Object.keys(ws?.agentToolPending ?? {}).length > 0
                                        }
                                        compacting={contextInfo.compacting}
                                        contextIndicator={{
                                            info: contextInfo.info,
                                            loading: contextInfo.loading,
                                            compacting: contextInfo.compacting,
                                            threshold:
                                                globalConfigState.global.compaction?.threshold,
                                        }}
                                        onInputChange={(v) => {
                                            setInput(v);
                                            autoResizeTextarea();
                                        }}
                                        onAttachmentsChange={setAttachments}
                                        onSend={async () => {
                                            const text = input;
                                            const imgs = attachments;
                                            setInput("");
                                            setAttachments([]);
                                            if (textareaRef.current) {
                                                textareaRef.current.style.height = "auto";
                                            }
                                            if (!(await sendPrompt(text, imgs))) {
                                                setInput(text);
                                                setAttachments(imgs);
                                            }
                                        }}
                                        onAbort={() => void abortPrompt()}
                                        activeLevel={activeLevel}
                                        onLevelChange={(next) => void setSessionLevel(next)}
                                        activeModel={activeModelWithFallback}
                                        onModelChange={(next) => void setSessionModel(next)}
                                        modelOptions={filteredOptions}
                                        onRefreshModels={refreshModels}
                                        textareaRef={textareaRef}
                                        onEnter={async () => {
                                            const text = input;
                                            const imgs = attachments;
                                            setInput("");
                                            setAttachments([]);
                                            if (textareaRef.current) {
                                                textareaRef.current.style.height = "auto";
                                            }
                                            if (!(await sendPrompt(text, imgs))) {
                                                setInput(text);
                                                setAttachments(imgs);
                                            }
                                        }}
                                        onCopySessionId={(sid) => void copySessionId(sid)}
                                        copiedSessionId={copiedSessionId}
                                        onToggleFiles={() => filesDrawer.show()}
                                        filesOpen={filesDrawer.open}
                                        isIm={Boolean(activeCwd?.startsWith(IM_CWD_PREFIX))}
                                        onCommandPermission={async (
                                            requestId,
                                            approved,
                                            scope: CommandPermissionScope,
                                        ) => {
                                            if (!activeCwd) return;
                                            await client.commandPermissionResolve(activeCwd, {
                                                requestId,
                                                approved,
                                                scope,
                                            });
                                        }}
                                    />
                                    {activeCwd && activeSid && (
                                        <TaskPanel
                                            cwd={activeCwd}
                                            sid={activeSid}
                                            workspaces={workspaces}
                                            client={client}
                                            dispatchWs={dispatchWs}
                                            forceExpand={
                                                !!workspaces[activeCwd]?.forceExpandTaskPanelByCwd[
                                                    activeCwd
                                                ]
                                            }
                                        />
                                    )}
                                </AskUserProvider>
                            </SubagentProvider>
                        </>
                    ) : mainView === "tools" ? (
                        <ToolsPane tools={tools} />
                    ) : mainView === "agents" ? (
                        <AgentsPane
                            agents={agents}
                            selectedAgentType={selectedAgentType ?? agents[0]?.agentType ?? null}
                            onSelect={setSelectedAgentType}
                            content={agentContent}
                            contentLoading={agentContentLoading}
                            contentError={agentContentError}
                        />
                    ) : mainView === "plugins" ? (
                        <PluginsPane
                            status={extensionStatus}
                            loading={extensionLoading}
                            error={extensionError}
                            savingName={extensionSavingName}
                            onToggle={(name, nextDisabled) =>
                                void toggleExtension(name, nextDisabled)
                            }
                            pendingRestart={extensionPendingRestart}
                            restarting={extensionRestarting}
                            onRestart={() => void restartForPlugins()}
                        />
                    ) : mainView === "channels" ? (
                        <ChannelsPane
                            client={client}
                            status={channelsStatus}
                            loading={channelsLoading}
                            error={channelsError}
                            savingId={channelsSavingId}
                            pendingRestart={channelsPendingRestart}
                            restarting={channelsRestarting}
                            onCreate={(name) => void createChannel(name)}
                            onRestart={() => void restartForChannels()}
                            onBind={(channelId) => {
                                setBindingChannelId(channelId);
                                void bindChannel(channelId);
                            }}
                            onRebind={(channelId) => {
                                setBindingChannelId(channelId);
                                void bindChannel(channelId, true);
                            }}
                            onUnbind={(channelId) => void unbindChannel(channelId)}
                            conversations={conversations}
                            conversationsLoading={conversationsLoading}
                            conversationsError={conversationsError}
                            conversationsUnread={conversationsUnread}
                            markConversationsSeen={markConversationsSeen}
                            onOpenConversation={(cwd, sid) => {
                                void openImConversation(cwd, sid);
                                setMainView("chat");
                            }}
                            activeCwd={activeCwd}
                        />
                    ) : mainView === "memory" ? (
                        <MemoryPane
                            data={memoryData}
                            loading={memoryLoading}
                            error={memoryError}
                            selectedId={memorySelectedId}
                            onSelect={setMemorySelectedId}
                            onSaveMemory={handleSaveMemory}
                            onDeleteTopic={handleDeleteTopic}
                            onRefresh={loadMemory}
                            saving={memorySaving}
                        />
                    ) : mainView === "checkpoints" ? (
                        <CheckpointsPane
                            data={checkpoints.data}
                            loading={checkpoints.loading}
                            error={checkpoints.error}
                            restoringId={checkpoints.restoringId}
                            refresh={checkpoints.refresh}
                            restore={checkpoints.restore}
                            hasActiveSession={Boolean(activeSid)}
                        />
                    ) : mainView === "settings" ? (
                        <SettingsPane
                            client={client}
                            onRestartSidecar={restartSidecar}
                            modelOptions={filteredOptions}
                            workspace={activeCwd || null}
                            onRefreshModels={refreshAfterKeyChange}
                            updateAvailable={updateStatus.available}
                            updateChecking={updateStatus.checking}
                            updateError={updateStatus.error}
                            onCheckUpdate={runUpdateCheck}
                        />
                    ) : mainView === "mcp" ? (
                        <div className="settings-pane">
                            <div className="settings-pane-content">
                                <div className="settings-pane-content-inner">
                                    <McpSection client={client} onRestart={restartSidecar} />
                                </div>
                            </div>
                        </div>
                    ) : (
                        <SkillsPane
                            skills={skills}
                            selectedName={selectedSkillName ?? skills[0]?.name ?? null}
                            onSelect={setSelectedSkillName}
                            content={skillContent}
                            contentLoading={skillContentLoading}
                            contentError={skillContentError}
                        />
                    )}
                </div>
            </div>
            <ConfirmModal
                open={confirmNewSession}
                title={t("session.createNewSessionTitle")}
                message={t("session.createNewSessionBody")}
                confirmLabel={t("session.discardAndCreate")}
                cancelLabel={t("session.cancel")}
                onConfirm={() => {
                    setConfirmNewSession(false);
                    const cwd = pendingNewSessionCwd ?? activeCwd;
                    setPendingNewSessionCwd(null);
                    setInput("");
                    setAttachments([]);
                    beginPendingNewSession(cwd);
                }}
                onCancel={() => {
                    setConfirmNewSession(false);
                    setPendingNewSessionCwd(null);
                }}
            />
            <ConfirmModal
                open={pendingDeleteSession !== null}
                title={t("session.deleteSessionTitle")}
                message={t("session.deleteSessionBody")}
                confirmLabel={t("session.deleteSession")}
                cancelLabel={t("session.cancel")}
                onConfirm={() => {
                    const target = pendingDeleteSession;
                    setPendingDeleteSession(null);
                    if (target) void deleteSession(target.cwd, target.sessionId);
                }}
                onCancel={() => setPendingDeleteSession(null)}
            />
            <RenameModal
                open={pendingRenameSession !== null}
                initialName={pendingRenameSession?.currentName ?? ""}
                title={t("session.renameTitle")}
                placeholder={t("session.renamePlaceholder")}
                confirmLabel={t("session.renameConfirm")}
                cancelLabel={t("session.cancel")}
                onSubmit={(name) => {
                    const target = pendingRenameSession;
                    setPendingRenameSession(null);
                    if (target) void renameSession(target.cwd, target.sessionId, name);
                }}
                onCancel={() => setPendingRenameSession(null)}
            />
            <ChannelBindDialog
                open={bindingChannelId !== null}
                channel={
                    channelsStatus?.configured.find((c) => c.channelId === bindingChannelId) ?? null
                }
                error={channelsError}
                onSubmitVerifyCode={submitVerifyCode}
                onCancel={() => setBindingChannelId(null)}
            />
            <FilesDrawer
                open={filesDrawer.open}
                activeCwd={activeCwd}
                onClose={filesDrawer.close}
            />
            {llmDumpOpen && (
                <LlmDumpPanel
                    entries={llmDump.entries}
                    onClear={llmDump.clear}
                    onCollapse={() => setLlmDumpOpen(false)}
                />
            )}
            {desktopConfig !== null && isOnboardingRequired(desktopConfig) && (
                <OnboardingModal
                    client={client}
                    wsApi={wsApi}
                    defaultCwd={getDefaultCwd()}
                    onComplete={(status: OnboardingStatus) => {
                        setDesktopConfig((prev) => ({ ...prev, onboarding: status }));
                    }}
                />
            )}
            <UpdateDialog
                open={updateDialog.open}
                initialVersion={updateDialog.version}
                onDismiss={() => setUpdateDialog({ open: false })}
            />
        </div>
    );
}
