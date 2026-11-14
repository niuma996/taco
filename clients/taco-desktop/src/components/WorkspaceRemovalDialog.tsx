import { asWorkspaceId, parseImCwd, type WorkspaceCleanupResult } from "@taco-ai/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../i18n/useI18n";
import type { TacoClient } from "../lib/clients/tacoClient";
import { Button } from "./ui/Button";
import { FormField } from "./ui/FormField";
import { Modal } from "./ui/Modal";
import { Switch } from "./ui/Switch";
import "../styles/workspaceRemoval.css";

export interface WorkspaceRemovalDialogProps {
    cwd: string;
    cleanup: boolean;
    client: TacoClient;
    onRemove: () => Promise<WorkspaceCleanupResult | undefined>;
    onClose: () => void;
}

export function WorkspaceRemovalDialog(props: WorkspaceRemovalDialogProps) {
    const { cwd, cleanup, client, onRemove, onClose } = props;
    const { t } = useT();
    const [preview, setPreview] = useState<WorkspaceCleanupResult | null>(null);
    const [previewError, setPreviewError] = useState<string | null>(null);
    const [loading, setLoading] = useState(cleanup);
    const [confirmed, setConfirmed] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [result, setResult] = useState<WorkspaceCleanupResult | null>(null);
    const pendingRef = useRef(false);
    const cancelRef = useRef<HTMLButtonElement>(null);
    const previewRequestRef = useRef(0);

    const loadPreview = useCallback(async (): Promise<void> => {
        const request = ++previewRequestRef.current;
        setLoading(true);
        setResult(null);
        setError(null);
        setPreview(null);
        setPreviewError(null);
        setConfirmed(false);
        // A rejected preview (including an older sidecar) must never turn into
        // permission to clean without showing the concrete targets first.
        try {
            const next = await client.workspaceCleanupPreview({ cwd: asWorkspaceId(cwd) });
            if (previewRequestRef.current === request) setPreview(next);
        } catch (cause) {
            if (previewRequestRef.current === request)
                setPreviewError(cause instanceof Error ? cause.message : String(cause));
        } finally {
            if (previewRequestRef.current === request) setLoading(false);
        }
    }, [client, cwd]);

    useEffect(() => {
        if (!cleanup) return;
        void loadPreview();
        return () => {
            previewRequestRef.current++;
        };
    }, [cleanup, loadPreview]);

    const canRemove =
        !busy &&
        (!cleanup ||
            (!loading &&
                result === null &&
                preview !== null &&
                preview.failed.length === 0 &&
                confirmed));

    const remove = async (): Promise<void> => {
        if (!canRemove || pendingRef.current) return;
        pendingRef.current = true;
        setBusy(true);
        setError(null);
        try {
            const next = await onRemove();
            if (next) setResult(next);
            if (next?.failed.length) {
                setConfirmed(false);
                return;
            }
            onClose();
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
            setConfirmed(false);
        } finally {
            pendingRef.current = false;
            setBusy(false);
        }
    };

    const details = result ?? preview;
    const isIm = Boolean(parseImCwd(cwd));
    const titleKey = cleanup
        ? isIm
            ? "workspaceRemoval.deleteImTitle"
            : "workspaceRemoval.cleanupTitle"
        : "workspaceRemoval.title";
    const actionKey = cleanup
        ? isIm
            ? "workspaceRemoval.confirmDeleteIm"
            : "workspaceRemoval.confirmRemoveAndClean"
        : "workspaceRemoval.remove";

    return (
        <Modal
            open
            title={t(titleKey)}
            description={t(
                cleanup
                    ? isIm
                        ? "workspaceRemoval.cleanupImHint"
                        : "workspaceRemoval.cleanupHint"
                    : isIm
                      ? "workspaceRemoval.hideImHint"
                      : "workspaceRemoval.hideLocalHint",
            )}
            className="workspace-removal-dialog"
            dismissible={!busy}
            onClose={onClose}
            onOpenAutoFocus={(event) => {
                event.preventDefault();
                cancelRef.current?.focus();
            }}
            actions={
                <>
                    <Button ref={cancelRef} variant="ghost" disabled={busy} onClick={onClose}>
                        {t("workspaceRemoval.cancel")}
                    </Button>
                    <Button
                        variant={cleanup ? "danger" : "primary"}
                        disabled={!canRemove}
                        aria-busy={busy}
                        onClick={() => void remove()}
                    >
                        {t(actionKey)}
                    </Button>
                </>
            }
        >
            <div className="workspace-removal-content" aria-busy={busy || loading}>
                <code className="workspace-removal-path">{cwd}</code>
                <p>{t("workspaceRemoval.sourceSafe")}</p>
                {loading && <p role="status">{t("workspaceRemoval.loading")}</p>}
                {previewError !== null && (
                    <div className="workspace-removal-error" role="alert">
                        <p>{t("workspaceRemoval.previewFailed")}</p>
                        <p>{previewError}</p>
                    </div>
                )}
                {details && (
                    <>
                        <section aria-label={t("workspaceRemoval.targets")}>
                            <h3>
                                {t(
                                    result
                                        ? "workspaceRemoval.removedTargets"
                                        : "workspaceRemoval.targets",
                                )}
                            </h3>
                            {details.removed.length === 0 ? (
                                <p>{t("workspaceRemoval.noTargets")}</p>
                            ) : (
                                <ul>
                                    {details.removed.map((path) => (
                                        <li key={path}>
                                            <code className="workspace-removal-path">{path}</code>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </section>
                        {details.skipped.length > 0 && (
                            <section aria-label={t("workspaceRemoval.retained")}>
                                <h3>{t("workspaceRemoval.retained")}</h3>
                                <ul>
                                    {details.skipped.map(({ path, reason }) => (
                                        <li key={path}>
                                            <code className="workspace-removal-path">{path}</code>
                                            <span>{reason}</span>
                                        </li>
                                    ))}
                                </ul>
                            </section>
                        )}
                        {details.failed.length > 0 && (
                            <section className="workspace-removal-error" role="alert">
                                <h3>
                                    {t(
                                        result
                                            ? "workspaceRemoval.partialFailure"
                                            : "workspaceRemoval.previewFailed",
                                    )}
                                </h3>
                                <ul>
                                    {details.failed.map(({ path, error: pathError }) => (
                                        <li key={path}>
                                            <code className="workspace-removal-path">{path}</code>
                                            <span>{pathError}</span>
                                        </li>
                                    ))}
                                </ul>
                            </section>
                        )}
                    </>
                )}
                {cleanup &&
                    (previewError !== null ||
                        (preview?.failed.length ?? 0) > 0 ||
                        (result?.failed.length ?? 0) > 0) && (
                        <Button disabled={busy || loading} onClick={() => void loadPreview()}>
                            {t("workspaceRemoval.retryPreview")}
                        </Button>
                    )}
                {cleanup &&
                    result === null &&
                    preview &&
                    !loading &&
                    preview.failed.length === 0 && (
                        <FormField
                            label={t("workspaceRemoval.confirmCleanup")}
                            hint={t("workspaceRemoval.confirmHint")}
                        >
                            <Switch
                                label={t("workspaceRemoval.confirmCleanup")}
                                checked={confirmed}
                                onChange={setConfirmed}
                                disabled={busy}
                            />
                        </FormField>
                    )}
                {error !== null && (
                    <div className="workspace-removal-error" role="alert">
                        <p>{t("workspaceRemoval.removeFailed")}</p>
                        <p>{error}</p>
                    </div>
                )}
                {busy && <p role="status">{t("workspaceRemoval.removing")}</p>}
            </div>
        </Modal>
    );
}
