/**
 * ImPolicyDialog — edit an IM channel's workspace policy (channel default or
 * a specific chat override).
 *
 * Each single-value field is a state card: it shows the effective value and
 * the layer that supplied it. The current layer either follows its parent or
 * overrides it; "restore" clears the field at that layer instead of copying
 * the parent's value. Allow/deny rules are always appended to the parent
 * layers, so the rule editor only lets the user add or remove rules owned by
 * the current scope.
 */

import type {
    ImCommandPolicyPatch,
    ImExecutionDir,
    ImPolicyChatOverrideEntry,
    ImPolicyRuleGroup,
    ImPolicySource,
    ImPolicySources,
    ImRoute,
    ImToolPolicyPatch,
    ImWorkspacePolicyPatch,
} from "@taco-ai/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { useImPolicy } from "../hooks/useImPolicy.ts";
import { useT } from "../i18n/useI18n.ts";
import type { TacoClient } from "../lib/clients/tacoClient.ts";
import { validatePermissionRuleClient } from "../lib/commandPermissionRuleClient.ts";
import { subscribeImPolicyChanged } from "../lib/imPolicyEvents.ts";
import { ConfirmModal } from "./ConfirmModal.tsx";
import { PolicyExecutionDirPicker } from "./imPolicy/PolicyExecutionDirPicker.tsx";
import { PolicyRuleLayers } from "./imPolicy/PolicyRuleLayers.tsx";
import { PolicyValueCard } from "./imPolicy/PolicyValueCard.tsx";
import { Button } from "./ui/Button.tsx";
import { Modal } from "./ui/Modal.tsx";
import { Select } from "./ui/Select.tsx";

export interface ImPolicyDialogProps {
    open: boolean;
    /** Pass `channelId` alone for channel-default mode; pass `peerId+chatId`
     *  for chat-override mode (which scopes the resolved policy and shows
     *  that chat's override row). */
    scope: { channelId: string; peerId?: string; chatId?: string } | null;
    client: TacoClient;
    onClose: () => void;
}

const SOURCE_KEYS: Record<ImPolicySource, string> = {
    default: "imPolicy.sourceDefault",
    global: "imPolicy.sourceGlobal",
    channel: "imPolicy.sourceChannel",
    chat: "imPolicy.sourceChat",
};

const RULE_SOURCE_KEYS: Record<"global" | "channel" | "chat", string> = {
    global: "imPolicy.sourceGlobal",
    channel: "imPolicy.sourceChannel",
    chat: "imPolicy.sourceChat",
};

function sameList(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function ImPolicyDialog(props: ImPolicyDialogProps): React.ReactElement | null {
    const { open, scope, client, onClose } = props;
    const { t } = useT();
    const routeScope: ImRoute | null =
        scope?.peerId && scope?.chatId
            ? { channelId: scope.channelId, peerId: scope.peerId, chatId: scope.chatId }
            : null;
    const policy = useImPolicy(client, routeScope);

    // `useImPolicy` returns a fresh object literal every render, so this ref is
    // the only stable handle to it — depending on `policy` itself would re-fire
    // the load effect on every render and loop forever.
    const policyRef = useRef(policy);
    policyRef.current = policy;

    const scopeKey = scope ? `${scope.channelId}|${scope.peerId ?? ""}|${scope.chatId ?? ""}` : "";

    // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
    useEffect(() => {
        if (!open || !scope) return;
        void policyRef.current.load(scope.channelId, scope.peerId, scope.chatId);
    }, [open, scope?.channelId, scope?.peerId, scope?.chatId]);

    useEffect(() => {
        if (!open) return;
        return subscribeImPolicyChanged((channelId) => {
            policyRef.current.onImPolicyChanged(channelId);
        });
    }, [open]);

    const data = policy.data;
    const isChannelScope = !routeScope;
    const rawPatch: ImWorkspacePolicyPatch | null | undefined = isChannelScope
        ? data?.channelDefault
        : data?.chatOverride;
    const editingPatch: ImWorkspacePolicyPatch = rawPatch ?? {};
    const resolved = data?.resolved;

    // Local drafts. `null` / empty string means "follow the parent"; the raw
    // layer patch tells us whether that means "omit" or "send null to clear".
    const [fsTools, setFsTools] = useState<"deny" | "allow" | null>(null);
    const [shell, setShell] = useState<"deny" | "allow" | null>(null);
    const [mode, setMode] = useState<"ask" | "auto" | null>(null);
    const [execDir, setExecDir] = useState<ImExecutionDir | null>(null);
    const [allowDraft, setAllowDraft] = useState<string[]>([]);
    const [denyDraft, setDenyDraft] = useState<string[]>([]);

    const [clientError, setClientError] = useState<string | null>(null);
    const [confirmingKey, setConfirmingKey] = useState<string | null>(null);
    const [confirmingSave, setConfirmingSave] = useState(false);

    // Once the user edits, a push-driven reload must not clobber their draft.
    const dirtyRef = useRef(false);
    const loadedKeyRef = useRef("");
    const markDirty = useCallback(() => {
        dirtyRef.current = true;
    }, []);

    useEffect(() => {
        if (loadedKeyRef.current !== scopeKey) {
            loadedKeyRef.current = scopeKey;
            dirtyRef.current = false;
        }
        if (dirtyRef.current) return;
        setFsTools(editingPatch.tools?.fsTools ?? null);
        setShell(editingPatch.tools?.shell ?? null);
        setMode(editingPatch.commands?.mode ?? null);
        setExecDir(editingPatch.executionDir ?? null);
        setAllowDraft(editingPatch.commands?.allow ?? []);
        setDenyDraft(editingPatch.commands?.deny ?? []);
        setClientError(null);
        setConfirmingKey(null);
    }, [
        scopeKey,
        editingPatch.tools?.fsTools,
        editingPatch.tools?.shell,
        editingPatch.commands?.mode,
        editingPatch.commands?.allow,
        editingPatch.commands?.deny,
        editingPatch.executionDir,
    ]);

    const fallbackSources: ImPolicySources = {
        fsTools: { value: resolved?.tools.fsTools ?? "deny", source: "default" },
        shell: { value: resolved?.tools.shell ?? "deny", source: "default" },
        commandMode: { value: resolved?.commands.mode ?? "ask", source: "default" },
        executionDir: { value: resolved?.executionDir ?? { mode: "shared" }, source: "default" },
    };
    const sources = data?.sources ?? fallbackSources;

    const withLocalGroup = (groups: ImPolicyRuleGroup[]): ImPolicyRuleGroup[] =>
        groups.some((group) => group.editable)
            ? groups
            : [
                  ...groups,
                  { source: isChannelScope ? "channel" : "chat", rules: [], editable: true },
              ];
    const allowGroups = withLocalGroup(data?.rules?.allow ?? []);
    const denyGroups = withLocalGroup(data?.rules?.deny ?? []);

    const sourceLabel = (source: ImPolicySource): string => t(SOURCE_KEYS[source]);
    const ruleSourceLabels = {
        global: t(RULE_SOURCE_KEYS.global),
        channel: t(RULE_SOURCE_KEYS.channel),
        chat: t(RULE_SOURCE_KEYS.chat),
    };
    const stateLabel = isChannelScope ? t("imPolicy.overrideChannel") : t("imPolicy.overrideChat");
    const currentSource: ImPolicySource = isChannelScope ? "channel" : "chat";
    const overrideLabel = isChannelScope ? t("imPolicy.setForChannel") : t("imPolicy.setForChat");

    const toolLabel = (value: "deny" | "allow"): string =>
        value === "allow" ? t("imPolicy.allow") : t("imPolicy.deny");
    const modeLabel = (value: "ask" | "auto"): string =>
        value === "auto" ? t("imPolicy.auto") : t("imPolicy.ask");
    const executionDirLabel = (dir: ImExecutionDir): string => {
        if (dir.mode === "custom") return dir.path ?? t("imPolicy.executionDirCustom");
        if (dir.mode === "per-chat") return t("imPolicy.executionDirPerChat");
        return t("imPolicy.executionDirShared");
    };

    const formDisabled = policy.loading || policy.saving;

    const buildPatch = useCallback((): ImWorkspacePolicyPatch | string => {
        const patch: ImWorkspacePolicyPatch = {};

        const tools: ImToolPolicyPatch = {};
        let toolsChanged = false;
        const originalFsTools = editingPatch.tools?.fsTools ?? undefined;
        const originalShell = editingPatch.tools?.shell ?? undefined;
        if (fsTools === null) {
            if (originalFsTools !== undefined) {
                tools.fsTools = null;
                toolsChanged = true;
            }
        } else if (fsTools !== originalFsTools) {
            tools.fsTools = fsTools;
            toolsChanged = true;
        }
        if (shell === null) {
            if (originalShell !== undefined) {
                tools.shell = null;
                toolsChanged = true;
            }
        } else if (shell !== originalShell) {
            tools.shell = shell;
            toolsChanged = true;
        }
        if (toolsChanged) patch.tools = tools;

        const commands: ImCommandPolicyPatch = {};
        let commandsChanged = false;
        const originalMode = editingPatch.commands?.mode ?? undefined;
        if (mode === null) {
            if (originalMode !== undefined) {
                commands.mode = null;
                commandsChanged = true;
            }
        } else if (mode !== originalMode) {
            commands.mode = mode;
            commandsChanged = true;
        }

        const originalAllow = editingPatch.commands?.allow ?? [];
        if (!sameList(allowDraft, originalAllow)) {
            commands.allow = allowDraft;
            commandsChanged = true;
        }
        const originalDeny = editingPatch.commands?.deny ?? [];
        if (!sameList(denyDraft, originalDeny)) {
            commands.deny = denyDraft;
            commandsChanged = true;
        }
        if (commandsChanged) patch.commands = commands;

        const originalDir = editingPatch.executionDir ?? undefined;
        if (execDir === null) {
            if (originalDir !== undefined) patch.executionDir = null;
        } else {
            if (execDir.mode === "custom") {
                const dirPath = (execDir.path ?? "").trim();
                if (dirPath.length === 0 || !dirPath.startsWith("/")) {
                    return t("imPolicy.invalidCwd");
                }
                if (dirPath !== execDir.path) {
                    patch.executionDir = { mode: "custom", path: dirPath };
                } else if (originalDir?.mode !== "custom" || originalDir.path !== dirPath) {
                    patch.executionDir = { mode: "custom", path: dirPath };
                }
            } else if (originalDir?.mode !== execDir.mode) {
                patch.executionDir = { mode: execDir.mode };
            }
        }

        return patch;
    }, [
        editingPatch.commands?.allow,
        editingPatch.commands?.deny,
        editingPatch.commands?.mode,
        editingPatch.executionDir,
        editingPatch.tools?.fsTools,
        editingPatch.tools?.shell,
        allowDraft,
        denyDraft,
        execDir,
        fsTools,
        mode,
        shell,
        t,
    ]);

    const save = useCallback(async () => {
        if (!scope) return;
        const built = buildPatch();
        if (typeof built === "string") {
            setClientError(built);
            return;
        }
        setClientError(null);
        if (isChannelScope) {
            const ok = await policy.saveChannelDefault(scope.channelId, built);
            if (ok) onClose();
        } else if (routeScope) {
            const ok = await policy.saveChatOverride(routeScope, built);
            if (ok) onClose();
        }
    }, [scope, buildPatch, isChannelScope, policy, onClose, routeScope]);

    const addRule = useCallback(
        (kind: "allow" | "deny") =>
            (raw: string): string | null => {
                const result = validatePermissionRuleClient(raw, {
                    allowShellWrapper: kind === "deny",
                });
                if (!result.valid) {
                    return result.reason.kind === "empty"
                        ? t("imPolicy.ruleErrorEmpty")
                        : t("imPolicy.ruleErrorShellWrapper", { shell: result.reason.shell });
                }
                markDirty();
                const append = (prev: string[]): string[] =>
                    Array.from(new Set([...prev, result.canonical]));
                if (kind === "allow") setAllowDraft(append);
                else setDenyDraft(append);
                return null;
            },
        [markDirty, t],
    );

    const removeRule = useCallback(
        (kind: "allow" | "deny", rule: string) => {
            markDirty();
            if (kind === "allow") setAllowDraft((prev) => prev.filter((r) => r !== rule));
            else setDenyDraft((prev) => prev.filter((r) => r !== rule));
        },
        [markDirty],
    );

    const clearOverrideEntry = useCallback(
        async (entry: ImPolicyChatOverrideEntry) => {
            if (!scope) return;
            const ok = await policy.clearChatOverrideByKey(scope.channelId, entry.key);
            if (ok) {
                setConfirmingKey(null);
                await policy.load(scope.channelId);
            }
        },
        [scope, policy],
    );

    if (!scope) return null;

    const effectiveFsTools = fsTools ?? sources.fsTools.value;
    const effectiveShell = shell ?? sources.shell.value;
    const effectiveMode = mode ?? sources.commandMode.value;
    const effectiveDir = execDir ?? sources.executionDir.value;

    return (
        <Modal
            open={open}
            onClose={onClose}
            title={
                isChannelScope
                    ? t("imPolicy.titleChannel", { channel: scope.channelId })
                    : t("imPolicy.titleChat", { peer: scope.peerId ?? "" })
            }
            description={
                isChannelScope
                    ? t("imPolicy.parentChannel")
                    : t("imPolicy.parentChat", { channel: scope.channelId })
            }
            className="im-policy-modal"
            actions={
                <>
                    <Button variant="ghost" onClick={onClose} disabled={formDisabled}>
                        {t("imPolicy.cancel")}
                    </Button>
                    <Button
                        variant="primary"
                        onClick={() => setConfirmingSave(true)}
                        disabled={formDisabled}
                    >
                        {t("imPolicy.save")}
                    </Button>
                </>
            }
        >
            <p className="im-policy-desc">{t("imPolicy.desc")}</p>
            {clientError !== null && <div className="error-banner">{clientError}</div>}
            {policy.error !== null && <div className="error-banner">{policy.error}</div>}
            {policy.loading && <div className="pane-loading">{t("imPolicy.loading")}</div>}

            <PolicyValueCard
                label={t("imPolicy.fsTools")}
                value={toolLabel(effectiveFsTools)}
                source={t("imPolicy.sourceLine", {
                    source: sourceLabel(fsTools === null ? sources.fsTools.source : currentSource),
                })}
                state={fsTools === null ? t("imPolicy.following") : stateLabel}
                overridden={fsTools !== null}
                overrideLabel={overrideLabel}
                resetLabel={t("imPolicy.resetToParent")}
                onOverride={() => {
                    markDirty();
                    setFsTools(effectiveFsTools);
                }}
                onReset={() => {
                    markDirty();
                    setFsTools(null);
                }}
                disabled={formDisabled}
            >
                <Select
                    value={effectiveFsTools}
                    onValueChange={(value) => {
                        markDirty();
                        setFsTools(value === "allow" ? "allow" : "deny");
                    }}
                    disabled={formDisabled}
                    label={t("imPolicy.fsTools")}
                    options={[
                        { value: "deny", label: t("imPolicy.deny") },
                        { value: "allow", label: t("imPolicy.allow") },
                    ]}
                />
            </PolicyValueCard>

            <PolicyValueCard
                label={t("imPolicy.shell")}
                value={toolLabel(effectiveShell)}
                source={t("imPolicy.sourceLine", {
                    source: sourceLabel(shell === null ? sources.shell.source : currentSource),
                })}
                state={shell === null ? t("imPolicy.following") : stateLabel}
                overridden={shell !== null}
                overrideLabel={overrideLabel}
                resetLabel={t("imPolicy.resetToParent")}
                onOverride={() => {
                    markDirty();
                    setShell(effectiveShell);
                }}
                onReset={() => {
                    markDirty();
                    setShell(null);
                }}
                disabled={formDisabled}
            >
                <Select
                    value={effectiveShell}
                    onValueChange={(value) => {
                        markDirty();
                        setShell(value === "allow" ? "allow" : "deny");
                    }}
                    disabled={formDisabled}
                    label={t("imPolicy.shell")}
                    options={[
                        { value: "deny", label: t("imPolicy.deny") },
                        { value: "allow", label: t("imPolicy.allow") },
                    ]}
                />
            </PolicyValueCard>

            <PolicyValueCard
                label={t("imPolicy.commandMode")}
                value={modeLabel(effectiveMode)}
                source={t("imPolicy.sourceLine", {
                    source: sourceLabel(mode === null ? sources.commandMode.source : currentSource),
                })}
                state={mode === null ? t("imPolicy.following") : stateLabel}
                overridden={mode !== null}
                overrideLabel={overrideLabel}
                resetLabel={t("imPolicy.resetToParent")}
                onOverride={() => {
                    markDirty();
                    setMode(effectiveMode);
                }}
                onReset={() => {
                    markDirty();
                    setMode(null);
                }}
                disabled={formDisabled}
            >
                <Select
                    value={effectiveMode}
                    onValueChange={(value) => {
                        markDirty();
                        setMode(value === "auto" ? "auto" : "ask");
                    }}
                    disabled={formDisabled}
                    label={t("imPolicy.commandMode")}
                    options={[
                        { value: "ask", label: t("imPolicy.ask") },
                        { value: "auto", label: t("imPolicy.auto") },
                    ]}
                />
            </PolicyValueCard>

            <PolicyRuleLayers
                title={t("imPolicy.allowRules")}
                hint={t("imPolicy.rulesAppendHint")}
                groups={allowGroups}
                localRules={allowDraft}
                sourceLabels={ruleSourceLabels}
                emptyLabel={t("imPolicy.noLocalRules")}
                addLabel={t("imPolicy.addRule")}
                removeLabel={t("imPolicy.removeRule")}
                inputPlaceholder={t("imPolicy.rulePlaceholder")}
                disabled={formDisabled}
                onAdd={addRule("allow")}
                onRemove={(rule) => removeRule("allow", rule)}
            />

            <PolicyRuleLayers
                title={t("imPolicy.denyRules")}
                hint={t("imPolicy.rulesAppendHint")}
                groups={denyGroups}
                localRules={denyDraft}
                sourceLabels={ruleSourceLabels}
                emptyLabel={t("imPolicy.noLocalRules")}
                addLabel={t("imPolicy.addRule")}
                removeLabel={t("imPolicy.removeRule")}
                inputPlaceholder={t("imPolicy.rulePlaceholder")}
                disabled={formDisabled}
                onAdd={addRule("deny")}
                onRemove={(rule) => removeRule("deny", rule)}
            />

            <PolicyValueCard
                label={t("imPolicy.executionCwd")}
                value={executionDirLabel(effectiveDir)}
                source={t("imPolicy.sourceLine", {
                    source: sourceLabel(
                        execDir === null ? sources.executionDir.source : currentSource,
                    ),
                })}
                state={execDir === null ? t("imPolicy.following") : stateLabel}
                overridden={execDir !== null}
                overrideLabel={overrideLabel}
                resetLabel={t("imPolicy.resetToParent")}
                onOverride={() => {
                    markDirty();
                    setExecDir(effectiveDir);
                }}
                onReset={() => {
                    markDirty();
                    setExecDir(null);
                }}
                disabled={formDisabled}
            >
                <PolicyExecutionDirPicker
                    value={effectiveDir}
                    onChange={(next) => {
                        markDirty();
                        setExecDir(next);
                    }}
                    disabled={formDisabled}
                    labels={{
                        shared: t("imPolicy.executionDirShared"),
                        perChat: t("imPolicy.executionDirPerChat"),
                        custom: t("imPolicy.executionDirCustom"),
                        sharedHint: t("imPolicy.executionDirSharedHint"),
                        perChatHint: t("imPolicy.executionDirPerChatHint"),
                        customHint: t("imPolicy.executionDirCustomHint"),
                        pathPlaceholder: t("imPolicy.executionCwdPlaceholder"),
                    }}
                />
            </PolicyValueCard>

            {/* Channel-scope only: list every chat override so the
                        admin can see and clear orphan grants. */}
            {isChannelScope && data && data.overrides.length > 0 && (
                <div className="im-policy-overrides">
                    <h4 className="im-policy-overrides-title">{t("imPolicy.overridesTitle")}</h4>
                    <ul className="im-policy-overrides-list">
                        {data.overrides.map((entry) => {
                            const label = entry.route ? entry.route.peerId : t("imPolicy.orphan");
                            const confirming = confirmingKey === entry.key;
                            return (
                                <li key={entry.key} className="im-policy-overrides-row">
                                    <span className="im-policy-overrides-label" title={entry.key}>
                                        {label}
                                    </span>
                                    <Button
                                        size="sm"
                                        variant={confirming ? "danger" : "ghost"}
                                        disabled={formDisabled}
                                        onClick={() => {
                                            if (confirming) {
                                                void clearOverrideEntry(entry);
                                            } else {
                                                setConfirmingKey(entry.key);
                                            }
                                        }}
                                    >
                                        {confirming
                                            ? t("imPolicy.confirmClear")
                                            : t("imPolicy.clearOverride")}
                                    </Button>
                                </li>
                            );
                        })}
                    </ul>
                </div>
            )}

            <ConfirmModal
                open={confirmingSave}
                title={t("imPolicy.saveConfirmTitle")}
                message={t("imPolicy.saveConfirmInterrupt")}
                confirmLabel={t("imPolicy.save")}
                cancelLabel={t("imPolicy.cancel")}
                onConfirm={() => {
                    setConfirmingSave(false);
                    void save();
                }}
                onCancel={() => setConfirmingSave(false)}
            />
        </Modal>
    );
}
