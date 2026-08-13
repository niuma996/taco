/**
 * ImPolicyDialog — edit a channel's IM workspace policy (channel default or
 * a specific chat override).
 *
 * Form semantics: every field is tri-state. The Select for fsTools / shell /
 * mode prepends an `inherit (current resolved value)` option; choosing
 * "inherit" omits the field from the patch so the next layer wins. Rule
 * lists (allow / deny) get an explicit "override this list" Switch — when
 * off, the list is omitted from the patch (inherited); when on, the rule
 * list replaces the inherited one. `binding.executionCwd` is a TextInput
 * where empty = inherit. `perChatScratch` is a tri-state Select (inheriting
 * the boolean) rather than a Switch, because the value is genuinely tri-state.
 *
 * Channel-scope mode additionally lists every chat override for the channel
 * (live + orphan) with a two-step Clear affordance.
 */

import * as Dialog from "@radix-ui/react-dialog";
import type { ImPolicyChatOverrideEntry, ImRoute, ImWorkspacePolicyPatch } from "@taco-ai/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { useImPolicy } from "../hooks/useImPolicy.ts";
import { useT } from "../i18n/useI18n.ts";
import type { ClientRuleValidationError } from "../lib/commandPermissionRuleClient.ts";
import { validatePermissionRuleClient } from "../lib/commandPermissionRuleClient.ts";
import { subscribeImPolicyChanged } from "../lib/imPolicyEvents.ts";
import type { TacoClient } from "../lib/tacoClientTauri.ts";
import { ConfirmModal } from "./ConfirmModal.tsx";
import { Button } from "./ui/Button.tsx";
import { FormField } from "./ui/FormField.tsx";
import { Select } from "./ui/Select.tsx";
import { Switch } from "./ui/Switch.tsx";
import { TextInput } from "./ui/TextInput.tsx";
export interface ImPolicyDialogProps {
    open: boolean;
    /** Pass `channelId` alone for channel-default mode; pass `peerId+chatId`
     *  for chat-override mode (which scopes the resolved policy and shows
     *  that chat's override row). */
    scope: { channelId: string; peerId?: string; chatId?: string } | null;
    client: TacoClient;
    onClose: () => void;
}

/** Sentinel for "omit this field from the patch". Kept module-local so the
 *  serialized Select values never collide with the legitimate `deny`/`allow`/
 *  `ask`/`auto`/`on`/`off` values. */
const INHERIT = "__inherit__";

/** Stable empty patch — avoids new-object references on every render that
 *  would otherwise re-fire the patch-reset effect during the initial load. */
const EMPTY_PATCH: ImWorkspacePolicyPatch = Object.freeze({}) as ImWorkspacePolicyPatch;

type TriString = typeof INHERIT | "deny" | "allow" | "ask" | "auto" | "on" | "off";

function triValue(v: string | undefined): TriString {
    return (v as TriString | undefined) ?? INHERIT;
}

function isInherit(tri: TriString): boolean {
    return tri === INHERIT;
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

    // Re-load when the dialog opens (or the scope changes mid-flight). Depends on
    // the raw scope fields, not the `scope` object: ChannelsPane rebuilds that
    // object on every render, which would otherwise re-fire this effect and
    // (via setData) start an infinite render loop. Adding `scope` to the deps
    // is therefore wrong even though react-hooks would prefer it.
    // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
    useEffect(() => {
        if (!open || !scope) return;
        void policyRef.current.load(scope.channelId, scope.peerId, scope.chatId);
    }, [open, scope?.channelId, scope?.peerId, scope?.chatId]);

    // Wire the `im.policy_changed` push to a silent re-load while the dialog
    // is open. App.tsx forwards the push to a tiny pub-sub emitter; this dialog
    // subscribes for the duration of its mount and reloads when the channel
    // matches.
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
    // Use a stable reference for the "no patch yet" branch so the reset
    // effect below doesn't re-fire on every render during the initial load.
    const editingPatch: ImWorkspacePolicyPatch = rawPatch ?? EMPTY_PATCH;

    // Tri-state mirrors of the patch. Initialized from `editingPatch`; reset
    // whenever the underlying patch changes (e.g. after a push re-load).
    const [fsTools, setFsTools] = useState<TriString>(INHERIT);
    const [shell, setShell] = useState<TriString>(INHERIT);
    const [mode, setMode] = useState<TriString>(INHERIT);
    const [allowEnabled, setAllowEnabled] = useState(false);
    const [allow, setAllow] = useState<string[]>([]);
    const [denyEnabled, setDenyEnabled] = useState(false);
    const [deny, setDeny] = useState<string[]>([]);
    const [cwd, setCwd] = useState("");
    const [perChatScratch, setPerChatScratch] = useState<TriString>(INHERIT);
    const [newAllowRule, setNewAllowRule] = useState("");
    const [newDenyRule, setNewDenyRule] = useState("");
    const [allowRuleError, setAllowRuleError] = useState<ClientRuleValidationError | null>(null);
    const [denyRuleError, setDenyRuleError] = useState<ClientRuleValidationError | null>(null);
    const [confirmingKey, setConfirmingKey] = useState<string | null>(null);
    // Surface client-side validation errors (e.g. cwd not absolute) that
    // `buildPatch` returns as a string. Distinct from `policy.error` which
    // carries RPC failures.
    const [clientError, setClientError] = useState<string | null>(null);
    // Save applies the policy immediately and may interrupt in-progress
    // conversations on this channel — gate it behind a ConfirmModal (matches
    // the dialog's own Radix-Dialog UI; no system modal on macOS Tauri).
    const [confirmingSave, setConfirmingSave] = useState(false);

    // Reset the local edit state when the underlying patch changes (push reload).
    useEffect(() => {
        setFsTools(triValue(editingPatch.tools?.fsTools));
        setShell(triValue(editingPatch.tools?.shell));
        setMode(triValue(editingPatch.commands?.mode));
        setAllowEnabled(editingPatch.commands?.allow !== undefined);
        setAllow(editingPatch.commands?.allow ?? []);
        setDenyEnabled(editingPatch.commands?.deny !== undefined);
        setDeny(editingPatch.commands?.deny ?? []);
        setCwd(editingPatch.binding?.executionCwd ?? "");
        setPerChatScratch(
            triValue(
                editingPatch.perChatScratch === undefined
                    ? undefined
                    : editingPatch.perChatScratch
                      ? "on"
                      : "off",
            ),
        );
        setConfirmingKey(null);
        // Depend on the source field (`rawPatch`) so the effect re-fires only
        // when the server actually delivers a new patch — not on every render.
    }, [
        editingPatch.tools?.fsTools,
        editingPatch.perChatScratch,
        editingPatch.commands?.allow,
        editingPatch.tools?.shell,
        editingPatch.commands?.mode,
        editingPatch.commands?.deny,
        editingPatch.binding?.executionCwd,
    ]);

    const resolved = data?.resolved;
    const resolvedFsTools = resolved?.tools.fsTools ?? "deny";
    const resolvedShell = resolved?.tools.shell ?? "deny";
    const resolvedMode = resolved?.commands.mode ?? "ask";
    const resolvedScratch = resolved?.perChatScratch ? "on" : "off";

    const buildPatch = useCallback((): ImWorkspacePolicyPatch | string => {
        const patch: ImWorkspacePolicyPatch = {};
        const tools: ImWorkspacePolicyPatch["tools"] = {};
        if (!isInherit(fsTools)) tools.fsTools = fsTools as "deny" | "allow";
        if (!isInherit(shell)) tools.shell = shell as "deny" | "allow";
        if (Object.keys(tools).length > 0) patch.tools = tools;

        const commands: ImWorkspacePolicyPatch["commands"] = {};
        if (!isInherit(mode)) commands.mode = mode as "ask" | "auto";
        if (allowEnabled) commands.allow = allow;
        if (denyEnabled) commands.deny = deny;
        if (Object.keys(commands).length > 0) patch.commands = commands;

        if (cwd.trim().length > 0) {
            if (!cwd.startsWith("/")) return t("imPolicy.invalidCwd");
            patch.binding = { executionCwd: cwd.trim() };
        }

        if (!isInherit(perChatScratch)) {
            patch.perChatScratch = perChatScratch === "on";
        }
        return patch;
    }, [fsTools, shell, mode, allowEnabled, allow, denyEnabled, deny, cwd, perChatScratch, t]);

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

    const visibleError = clientError ?? policy.error;

    const addRule = useCallback(
        (kind: "allow" | "deny") => {
            const raw = kind === "allow" ? newAllowRule : newDenyRule;
            const set = kind === "allow" ? setAllow : setDeny;
            const setError = kind === "allow" ? setAllowRuleError : setDenyRuleError;
            const setRaw = kind === "allow" ? setNewAllowRule : setNewDenyRule;
            const result = validatePermissionRuleClient(raw);
            if (!result.valid) {
                setError(result.reason);
                return;
            }
            setError(null);
            if (!set) return;
            set((prev) => Array.from(new Set([...prev, result.canonical])));
            setRaw("");
        },
        [newAllowRule, newDenyRule],
    );

    const removeRule = useCallback((kind: "allow" | "deny", rule: string) => {
        const set = kind === "allow" ? setAllow : setDeny;
        if (!set) return;
        set((prev) => prev.filter((r) => r !== rule));
    }, []);

    const clearOverrideEntry = useCallback(
        async (entry: ImPolicyChatOverrideEntry) => {
            if (!scope) return;
            const ok = await policy.clearChatOverrideByKey(scope.channelId, entry.key);
            if (ok) {
                setConfirmingKey(null);
                // Re-load the channel view so the cleared row disappears.
                await policy.load(scope.channelId);
            }
        },
        [scope, policy],
    );

    if (!scope) return null;

    return (
        <Dialog.Root
            open={open}
            onOpenChange={(next) => {
                if (!next) onClose();
            }}
        >
            <Dialog.Portal>
                <Dialog.Overlay className="modal-backdrop" />
                <Dialog.Content className="modal im-policy-modal">
                    <Dialog.Title className="modal-title">
                        {isChannelScope
                            ? t("imPolicy.titleChannel", { channel: scope.channelId })
                            : t("imPolicy.titleChat")}
                    </Dialog.Title>
                    <p className="im-policy-desc">{t("imPolicy.desc")}</p>
                    {visibleError && <div className="error-banner">{visibleError}</div>}
                    {policy.loading && <div className="pane-loading">{t("imPolicy.loading")}</div>}

                    {/* fsTools */}
                    <FormField label={t("imPolicy.fsTools")}>
                        <Select
                            value={fsTools}
                            onValueChange={(v) => setFsTools(v as TriString)}
                            disabled={policy.saving}
                            options={[
                                {
                                    value: INHERIT,
                                    label: t("imPolicy.inherit", { value: resolvedFsTools }),
                                },
                                { value: "deny", label: t("imPolicy.deny") },
                                { value: "allow", label: t("imPolicy.allow") },
                            ]}
                            label={t("imPolicy.fsTools")}
                        />
                    </FormField>

                    {/* shell */}
                    <FormField label={t("imPolicy.shell")}>
                        <Select
                            value={shell}
                            onValueChange={(v) => setShell(v as TriString)}
                            disabled={policy.saving}
                            options={[
                                {
                                    value: INHERIT,
                                    label: t("imPolicy.inherit", { value: resolvedShell }),
                                },
                                { value: "deny", label: t("imPolicy.deny") },
                                { value: "allow", label: t("imPolicy.allow") },
                            ]}
                            label={t("imPolicy.shell")}
                        />
                    </FormField>

                    {/* commands.mode */}
                    <FormField label={t("imPolicy.commandMode")}>
                        <Select
                            value={mode}
                            onValueChange={(v) => setMode(v as TriString)}
                            disabled={policy.saving}
                            options={[
                                {
                                    value: INHERIT,
                                    label: t("imPolicy.inherit", { value: resolvedMode }),
                                },
                                { value: "ask", label: t("imPolicy.ask") },
                                { value: "auto", label: t("imPolicy.auto") },
                            ]}
                            label={t("imPolicy.commandMode")}
                        />
                    </FormField>

                    {/* allow rules */}
                    <RuleListField
                        title={t("imPolicy.allowRules")}
                        enabled={allowEnabled}
                        onEnabledChange={setAllowEnabled}
                        rules={allow}
                        input={newAllowRule}
                        onInputChange={setNewAllowRule}
                        onAdd={() => addRule("allow")}
                        onRemove={(r) => removeRule("allow", r)}
                        error={allowRuleError}
                        disabled={policy.saving}
                        addLabel={t("imPolicy.addRule")}
                        removeLabel={t("imPolicy.removeRule")}
                        inputPlaceholder={t("imPolicy.rulePlaceholder")}
                        emptyLabel={t("imPolicy.noRules")}
                    />

                    {/* deny rules */}
                    <RuleListField
                        title={t("imPolicy.denyRules")}
                        enabled={denyEnabled}
                        onEnabledChange={setDenyEnabled}
                        rules={deny}
                        input={newDenyRule}
                        onInputChange={setNewDenyRule}
                        onAdd={() => addRule("deny")}
                        onRemove={(r) => removeRule("deny", r)}
                        error={denyRuleError}
                        disabled={policy.saving}
                        addLabel={t("imPolicy.addRule")}
                        removeLabel={t("imPolicy.removeRule")}
                        inputPlaceholder={t("imPolicy.rulePlaceholder")}
                        emptyLabel={t("imPolicy.noRules")}
                    />

                    {/* binding.executionCwd */}
                    <FormField label={t("imPolicy.executionCwd")}>
                        <TextInput
                            type="text"
                            value={cwd}
                            disabled={policy.saving}
                            placeholder={t("imPolicy.executionCwdPlaceholder")}
                            onChange={(e) => setCwd(e.target.value)}
                        />
                    </FormField>

                    {/* perChatScratch */}
                    <FormField label={t("imPolicy.perChatScratch")}>
                        <Select
                            value={perChatScratch}
                            onValueChange={(v) => setPerChatScratch(v as TriString)}
                            disabled={policy.saving}
                            options={[
                                {
                                    value: INHERIT,
                                    label: t("imPolicy.inherit", { value: resolvedScratch }),
                                },
                                { value: "on", label: t("imPolicy.on") },
                                { value: "off", label: t("imPolicy.off") },
                            ]}
                            label={t("imPolicy.perChatScratch")}
                        />
                    </FormField>

                    {/* Channel-scope only: list every chat override so the
                        admin can see and clear orphan grants. */}
                    {isChannelScope && data && data.overrides.length > 0 && (
                        <div className="im-policy-overrides">
                            <h4 className="im-policy-overrides-title">
                                {t("imPolicy.overridesTitle")}
                            </h4>
                            <ul className="im-policy-overrides-list">
                                {data.overrides.map((entry) => {
                                    const label = entry.route
                                        ? entry.route.peerId
                                        : t("imPolicy.orphan");
                                    const confirming = confirmingKey === entry.key;
                                    return (
                                        <li key={entry.key} className="im-policy-overrides-row">
                                            <span
                                                className="im-policy-overrides-label"
                                                title={entry.key}
                                            >
                                                {label}
                                            </span>
                                            <Button
                                                size="sm"
                                                variant={confirming ? "danger" : "ghost"}
                                                disabled={policy.saving}
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

                    <div className="modal-actions">
                        <Button variant="ghost" onClick={onClose} disabled={policy.saving}>
                            {t("imPolicy.cancel")}
                        </Button>
                        <Button
                            variant="primary"
                            onClick={() => setConfirmingSave(true)}
                            disabled={policy.saving}
                        >
                            {t("imPolicy.save")}
                        </Button>
                    </div>
                </Dialog.Content>
            </Dialog.Portal>
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
        </Dialog.Root>
    );
}

interface RuleListFieldProps {
    title: string;
    enabled: boolean;
    onEnabledChange: (next: boolean) => void;
    rules: string[];
    input: string;
    onInputChange: (next: string) => void;
    onAdd: () => void;
    onRemove: (rule: string) => void;
    error: ClientRuleValidationError | null;
    disabled: boolean;
    addLabel: string;
    removeLabel: string;
    inputPlaceholder: string;
    emptyLabel: string;
}

function RuleListField(props: RuleListFieldProps): React.ReactElement {
    const { t } = useT();
    const {
        title,
        enabled,
        onEnabledChange,
        rules,
        input,
        onInputChange,
        onAdd,
        onRemove,
        error,
        disabled,
        addLabel,
        removeLabel,
        inputPlaceholder,
        emptyLabel,
    } = props;
    return (
        <div className="im-policy-rules">
            <div className="im-policy-rules-header">
                <span className="ui-form-label">{title}</span>
                <Switch label={title} onChange={onEnabledChange} checked={enabled} />
            </div>
            {enabled && (
                <>
                    <div className="settings-row">
                        <TextInput
                            type="text"
                            value={input}
                            disabled={disabled}
                            placeholder={inputPlaceholder}
                            onChange={(e) => onInputChange(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") onAdd();
                            }}
                        />
                        <button
                            type="button"
                            className="settings-btn"
                            disabled={disabled || input.trim().length === 0}
                            onClick={onAdd}
                        >
                            {addLabel}
                        </button>
                    </div>
                    {error && (
                        <div className="error-banner">
                            {error.kind === "empty"
                                ? t("imPolicy.ruleErrorEmpty")
                                : t("imPolicy.ruleErrorShellWrapper", { shell: error.shell })}
                        </div>
                    )}
                    {rules.length === 0 ? (
                        <p className="settings-tab-desc">{emptyLabel}</p>
                    ) : (
                        <ul className="permission-rule-list">
                            {rules.map((rule) => (
                                <li key={rule}>
                                    <span className="permission-rule-text">
                                        <code>{rule}</code>
                                    </span>
                                    <button
                                        type="button"
                                        className="permission-rule-remove"
                                        disabled={disabled}
                                        onClick={() => onRemove(rule)}
                                        aria-label={removeLabel}
                                    >
                                        ×
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </>
            )}
        </div>
    );
}
