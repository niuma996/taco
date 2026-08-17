/**
 * UpdateDialog — modal that surfaces a pending desktop update.
 *
 * Lifecycle:
 *   1. App.tsx's mount-time `checkForUpdate()` decides whether the
 *      dialog opens at all (parent owns `open`).
 *   2. On open we re-check (`checkForUpdate` again) so the version
 *      string shown matches the latest manifest — the parent check
 *      happened during a different React render and could be stale by
 *      the time the user opens the modal.
 *   3. Clicking "Now" runs `applyUpdate`, which renders the progress
 *      bar. On success we land in `ready` and the primary button
 *      relabels to "Restart now" — that one calls `relaunchDesktop`
 *      (no silent swallow, so an OS elevation-cancel surfaces back
 *      here as an `error` state).
 *   4. Clicking "Later" just dismisses — the next mount re-checks.
 *
 * Why a dedicated modal instead of inlining in App.tsx:
 *   The check/install/race orchestration is a real state machine; keeping
 *   it out of App.tsx avoids another useState cluster. The component is
 *   presentation-only — all side effects go through `./lib/updater`
 *   so tests can stub the wrapper.
 */
import * as Dialog from "@radix-ui/react-dialog";
import { useCallback, useEffect, useState } from "react";
import { applyUpdate, checkForUpdate, relaunchDesktop, type UpdateStatus } from "../lib/updater.ts";
import { Button } from "./ui/Button.tsx";

export interface UpdateDialogProps {
    /** Controlled open state from App.tsx. */
    open: boolean;
    /** Initial version detected by App.tsx's mount-time check. */
    initialVersion?: string;
    /** Called when the user dismisses ("Later" or backdrop click). */
    onDismiss: () => void;
    /** Called after a successful install so the parent can re-render. */
    onInstalled?: (version: string) => void;
}

export function UpdateDialog(props: UpdateDialogProps) {
    const { open, initialVersion, onDismiss, onInstalled } = props;
    const [status, setStatus] = useState<UpdateStatus>({
        state: initialVersion ? "available" : "idle",
        version: initialVersion,
    });
    const [progress, setProgress] = useState(0);

    // Re-check on open so the version we display matches the latest
    // manifest, not the snapshot the parent took at mount. Cheap (single
    // GET against the GitHub Releases endpoint) and avoids a stale
    // version string when the modal opens minutes after the parent's
    // check.
    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        void checkForUpdate().then((next) => {
            if (cancelled) return;
            if (next.state === "available" || next.state === "idle") {
                setStatus(next);
            } else {
                // Error: keep the parent's initialVersion so the dialog
                // isn't empty, but reflect the actual state.
                setStatus({ ...next, version: next.version ?? initialVersion });
            }
        });
        return () => {
            cancelled = true;
        };
    }, [open, initialVersion]);

    const onUpgrade = useCallback(() => {
        setStatus((s) => ({ ...s, state: "downloading", progress: 0 }));
        setProgress(0);
        void (async () => {
            const result = await applyUpdate((p) => {
                setProgress(p);
            });
            if (result.state === "ready" && result.version && onInstalled) {
                onInstalled(result.version);
            }
            setStatus(result);
            if (result.state !== "downloading" && result.state !== "ready") {
                setProgress(0);
            }
        })();
    }, [onInstalled]);

    const onRelaunch = useCallback(() => {
        void (async () => {
            try {
                await relaunchDesktop();
            } catch (err) {
                setStatus((s) => ({
                    state: "error",
                    error: err instanceof Error ? err.message : String(err),
                    version: s.version,
                }));
            }
        })();
    }, []);

    const version = status.version ?? initialVersion;
    const title =
        status.state === "error"
            ? "Update failed"
            : version
              ? `Update available: v${version}`
              : "Update available";

    const body = (() => {
        switch (status.state) {
            case "error":
                return `Update failed: ${status.error ?? "unknown error"}. You can retry, dismiss, or check the release page manually.`;
            case "downloading":
                return `Downloading v${version ?? ""}… ${Math.round(progress * 100)}%`;
            case "ready":
                return `v${version ?? ""} installed. Click "Restart now" to finish.`;
            default:
                return `A new desktop version (v${version ?? ""}) is available. Install now to get the latest fixes and features.`;
        }
    })();

    const canUpgrade = status.state === "available";
    const canRelaunch = status.state === "ready";
    const canCancel = status.state !== "downloading" && status.state !== "ready";

    const primaryLabel = canRelaunch ? "Restart now" : "Update now";

    const onPrimary = () => {
        if (canUpgrade) onUpgrade();
        else if (canRelaunch) onRelaunch();
    };

    return (
        <Dialog.Root
            open={open}
            onOpenChange={(next) => {
                if (!next && canCancel) onDismiss();
            }}
        >
            <Dialog.Portal>
                <Dialog.Overlay className="modal-backdrop" />
                <Dialog.Content className="modal update-dialog">
                    <Dialog.Title className="modal-title">{title}</Dialog.Title>
                    <Dialog.Description className="modal-message">{body}</Dialog.Description>
                    {status.state === "downloading" ? (
                        <div
                            className="update-progress"
                            role="progressbar"
                            aria-valuenow={Math.round(progress * 100)}
                            aria-valuemin={0}
                            aria-valuemax={100}
                        >
                            <div
                                className="update-progress-bar"
                                style={{ width: `${Math.round(progress * 100)}%` }}
                            />
                        </div>
                    ) : null}
                    <div className="modal-actions">
                        <Button variant="ghost" disabled={!canCancel} onClick={onDismiss}>
                            Later
                        </Button>
                        <Button
                            variant="primary"
                            disabled={!canUpgrade && !canRelaunch}
                            onClick={onPrimary}
                        >
                            {primaryLabel}
                        </Button>
                    </div>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
