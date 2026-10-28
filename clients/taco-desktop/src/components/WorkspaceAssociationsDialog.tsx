/**
 * WorkspaceAssociationsDialog — edit the directories a workspace may reach
 * beyond its own root.
 *
 * An association widens the workspace's COMMAND SCOPE: the agent may `cd`
 * into an associated directory and run commands there. It does not merge
 * another workspace's configuration — tool configuration, MCP servers and
 * subagent toolsets stay anchored to the workspace's own root. The dialog
 * says so, because "associated" invites the wrong reading.
 *
 * GRANULARITY. An IM conversation can be associated on its own or across the
 * whole channel. The user picks: a conversation-scoped set belongs to that
 * conversation alone, a channel-scoped set covers every conversation on the
 * channel — including ones that start later. A conversation-scoped set wins
 * over the channel's when both exist, so a specific conversation can be
 * narrowed without touching the rest.
 *
 * The list is edited as a whole: the user adds or removes rows, then saves
 * the full list. The store replaces rather than merges, so a partial update
 * would need a read-modify-write whose result could be stale by the time it
 * lands.
 */

import type { WorkspaceAssociationKey, WorkspaceAssociationScope } from "@taco-ai/protocol";
import { parseImCwd } from "@taco-ai/protocol";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FolderOpen, FolderPlus, Trash } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useWorkspaceAssociations } from "../hooks/useWorkspaceAssociations";
import { useT } from "../i18n/useI18n";
import type { TacoClient } from "../lib/clients/tacoClient.ts";
import { subscribeWorkspaceAssociationsChanged } from "../lib/workspaceAssociationEvents.ts";
import { lastSegment } from "../lib/workspaceStorage";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";
import { Modal } from "./ui/Modal";
import { Select } from "./ui/Select";
import { TextInput } from "./ui/TextInput";

export interface WorkspaceAssociationsDialogProps {
    open: boolean;
    onClose: () => void;
    client: TacoClient;
    /** The workspace whose associations are being edited — a directory path
     *  or an `im://` conversation URL. */
    workspace: string;
}

export function WorkspaceAssociationsDialog({
    open,
    onClose,
    client,
    workspace,
}: WorkspaceAssociationsDialogProps) {
    const { t } = useT();
    const { loading, saving, error, load, save } = useWorkspaceAssociations(client);
    // The list being edited. Seeded from the store on open, then owned by
    // the dialog until the user saves.
    const [draft, setDraft] = useState<string[]>([]);
    const [adding, setAdding] = useState(false);
    const [newRoot, setNewRoot] = useState("");
    // Which level the edit applies to. An IM conversation offers both; a
    // directory has only one.
    const [scope, setScope] = useState<WorkspaceAssociationScope>("workspace");

    // Memoized on the string: parseImCwd returns a fresh object each call, and
    // `key` below feeds the load effect — an unstable route re-ran the load
    // on every render, looping between "loading" and the loaded list.
    const imRoute = useMemo(() => (workspace ? parseImCwd(workspace) : undefined), [workspace]);
    const canChooseScope = imRoute !== undefined;
    const channelId = imRoute?.channelId;

    const key: WorkspaceAssociationKey = useMemo(
        () =>
            scope === "channel" && channelId
                ? { scope: "channel", id: channelId }
                : { scope: "workspace", id: workspace },
        [scope, channelId, workspace],
    );

    useEffect(() => {
        if (!open) return;
        setAdding(false);
        setNewRoot("");
        void load(key).then((loaded) => setDraft(loaded));
    }, [open, key, load]);

    // A change made elsewhere (another window, the CLI) invalidates what is
    // on screen. Re-load, but only when it is the key being edited — a
    // change to another workspace must not disturb this dialog.
    useEffect(() => {
        if (!open) return;
        return subscribeWorkspaceAssociationsChanged((changed) => {
            if (changed.scope !== key.scope || changed.id !== key.id) return;
            void load(changed).then((loaded) => setDraft(loaded));
        });
    }, [open, key, load]);

    const addRoot = useCallback(() => {
        const value = newRoot.trim();
        if (value.length === 0) return;
        if (!draft.includes(value)) setDraft([...draft, value]);
        setNewRoot("");
        setAdding(false);
    }, [draft, newRoot]);

    const browseRoot = useCallback(async () => {
        const selected = await openDialog({ directory: true });
        if (selected && !Array.isArray(selected)) {
            if (!draft.includes(selected)) setDraft([...draft, selected]);
            setNewRoot("");
            setAdding(false);
        }
    }, [draft]);

    const removeRoot = useCallback(
        (root: string) => {
            setDraft(draft.filter((r) => r !== root));
        },
        [draft],
    );

    const handleSave = useCallback(async () => {
        const ok = await save(key, draft);
        if (ok) onClose();
    }, [draft, key, onClose, save]);

    const workspaceLabel = imRoute ? imRoute.peerId : lastSegment(workspace);

    return (
        <Modal
            open={open}
            onClose={onClose}
            dismissible={!saving}
            title={t("associations.title", { workspace: workspaceLabel })}
            description={t("associations.description")}
            className="workspace-associations-modal"
            actions={
                <>
                    <Button variant="ghost" onClick={onClose} disabled={saving}>
                        {t("associations.cancel")}
                    </Button>
                    <Button variant="primary" onClick={() => void handleSave()} disabled={saving}>
                        {saving ? t("app.saving") : t("associations.save")}
                    </Button>
                </>
            }
        >
            {error && (
                <div className="ui-form-error" role="alert">
                    {error}
                </div>
            )}
            {canChooseScope && (
                <div className="workspace-associations-scope">
                    <span className="workspace-associations-scope-label">
                        {t("associations.scopeLabel")}
                    </span>
                    <Select
                        value={scope}
                        onValueChange={(v) => setScope(v as WorkspaceAssociationScope)}
                        label={t("associations.scopeLabel")}
                        options={[
                            { value: "workspace", label: t("associations.scopeConversation") },
                            { value: "channel", label: t("associations.scopeChannel") },
                        ]}
                    />
                </div>
            )}
            {loading ? (
                <div className="workspace-associations-empty">{t("associations.loading")}</div>
            ) : (
                <div className="workspace-associations-list">
                    {draft.length === 0 && !adding && (
                        <div className="workspace-associations-empty">
                            {t("associations.empty")}
                        </div>
                    )}
                    {draft.map((root) => (
                        <div
                            key={root}
                            className="workspace-associations-row workspace-associations-entry"
                        >
                            <span className="workspace-associations-path" title={root}>
                                {root}
                            </span>
                            <IconButton
                                size="sm"
                                variant="ghost"
                                tone="danger"
                                aria-label={t("associations.remove")}
                                onClick={() => removeRoot(root)}
                            >
                                <Trash size={12} aria-hidden="true" />
                            </IconButton>
                        </div>
                    ))}
                    {adding && (
                        <div className="workspace-associations-row workspace-associations-add-row">
                            <TextInput
                                value={newRoot}
                                autoFocus
                                placeholder={t("associations.pathPlaceholder")}
                                aria-label={t("associations.pathPlaceholder")}
                                onChange={(e) => setNewRoot(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                        e.preventDefault();
                                        addRoot();
                                    } else if (e.key === "Escape") {
                                        e.preventDefault();
                                        setAdding(false);
                                        setNewRoot("");
                                    }
                                }}
                            />
                            <IconButton
                                variant="outline"
                                aria-label={t("associations.browse")}
                                title={t("associations.browse")}
                                onClick={() => void browseRoot()}
                            >
                                <FolderOpen size={14} aria-hidden="true" />
                            </IconButton>
                            <Button variant="default" onClick={addRoot}>
                                {t("associations.add")}
                            </Button>
                        </div>
                    )}
                    {!adding && (
                        <Button
                            variant="ghost"
                            className="workspace-associations-add"
                            onClick={() => setAdding(true)}
                        >
                            <FolderPlus size={14} aria-hidden="true" />
                            {t("associations.addDirectory")}
                        </Button>
                    )}
                </div>
            )}
        </Modal>
    );
}
