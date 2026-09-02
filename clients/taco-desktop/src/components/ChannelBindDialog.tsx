/**
 * ChannelBindDialog — QR scan + pairing-code prompt for binding an IM channel.
 *
 * Purely driven by the channel's pushed state: `awaiting_scan` renders the QR,
 * `awaiting_verify_code` swaps in the code input, and `connected` closes. The
 * dialog holds no polling of its own.
 */
import * as Dialog from "@radix-ui/react-dialog";
import type { ChannelStatusEntry, ChannelsBindCreds } from "@taco-ai/protocol";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useRef, useState } from "react";
import { CHANNEL_NAME_WECOM } from "../hooks/useChannelsPane";
import { useT } from "../i18n/useI18n";
import { Button } from "./ui/Button.tsx";
import { TextInput } from "./ui/TextInput.tsx";

export interface ChannelBindDialogProps {
    open: boolean;
    channel: ChannelStatusEntry | null;
    /** Pane-level RPC error. Surfaced here too, or a failed bind would leave
     *  the dialog stuck on "connecting" with the reason only in the log. */
    error?: string | null;
    onSubmitVerifyCode: (requestId: string, code: string) => Promise<boolean>;
    /** Bind with pasted credentials; only invoked for channels without a QR
     *  flow (weCom today). The dialog decides when this fires — the App
     *  layer only opens the dialog, never the RPC. */
    onBindCreds: (creds: ChannelsBindCreds) => void;
    onCancel: () => void;
}

export function ChannelBindDialog(props: ChannelBindDialogProps) {
    const { open, channel, error, onSubmitVerifyCode, onBindCreds, onCancel } = props;
    const { t } = useT();
    const inputRef = useRef<HTMLInputElement>(null);
    const [code, setCode] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [wecomBotId, setWecomBotId] = useState("");
    const [wecomSecret, setWecomSecret] = useState("");
    const [wecomSubmitted, setWecomSubmitted] = useState(false);

    const state = channel?.state;
    const requestId = channel?.requestId;

    // Reset the field when a new prompt arrives, so a rejected code is not
    // resubmitted verbatim on the retry. Adjusted during render rather than in
    // an effect: an effect would need requestId as a dependency purely as a
    // change signal, which the exhaustive-deps rule flags as redundant.
    const [lastRequestId, setLastRequestId] = useState(requestId);
    if (requestId !== lastRequestId) {
        setLastRequestId(requestId);
        setCode("");
    }

    // Reset wecom creds form whenever the dialog switches channels.
    const [lastChannelId, setLastChannelId] = useState(channel?.channelId);
    if (channel?.channelId !== lastChannelId) {
        setLastChannelId(channel?.channelId);
        setWecomSubmitted(false);
        setWecomBotId("");
        setWecomSecret("");
    }

    const trimmed = code.trim();
    const canSubmit = trimmed.length > 0 && !submitting && requestId !== undefined;

    const isWeCom = channel?.name === CHANNEL_NAME_WECOM;
    // Show the credential form for wecom until the user submits it. This
    // covers both first-time Bind (unbound) and Rebind (already connected) —
    // for the latter the user is here to change creds, and the boundHint
    // auto-close below would otherwise yank the dialog shut.
    const wecomCredsMode = isWeCom && !wecomSubmitted;

    // Bound → show a success line, then close. Without the branch the dialog
    // re-renders as just a title + Close on the transition to connected.
    const isConnected = state === "connected";
    useEffect(() => {
        if (!isConnected) return;
        if (wecomCredsMode) return;
        const timer = window.setTimeout(onCancel, 900);
        return () => window.clearTimeout(timer);
    }, [isConnected, wecomCredsMode, onCancel]);

    const submit = async () => {
        if (!canSubmit || requestId === undefined) return;
        setSubmitting(true);
        try {
            await onSubmitVerifyCode(requestId, trimmed);
        } finally {
            setSubmitting(false);
        }
    };

    const submitWecomCreds = () => {
        const botId = wecomBotId.trim();
        const secret = wecomSecret.trim();
        if (!botId || !secret) return;
        setWecomSubmitted(true);
        onBindCreds({ botId, secret });
    };

    return (
        <Dialog.Root
            open={open}
            onOpenChange={(next) => {
                if (!next) onCancel();
            }}
        >
            <Dialog.Portal>
                <Dialog.Overlay className="modal-backdrop" />
                <Dialog.Content
                    className="modal channel-bind-modal"
                    onOpenAutoFocus={(e) => {
                        e.preventDefault();
                        inputRef.current?.focus();
                    }}
                >
                    <Dialog.Title className="modal-title">{t("channels.bindTitle")}</Dialog.Title>

                    {error && <p className="channel-bind-error">{error}</p>}

                    {state === "awaiting_scan" &&
                        (channel?.qrUrl ? (
                            <div className="channel-bind-qr">
                                <QRCodeSVG
                                    value={channel.qrUrl}
                                    size={200}
                                    level="M"
                                    role="img"
                                    aria-label={t("channels.scanHint")}
                                />
                                <p className="channel-bind-hint">{t("channels.scanHint")}</p>
                            </div>
                        ) : (
                            <p className="channel-bind-hint">{t("channels.connectingHint")}</p>
                        ))}

                    {state === "scanned" && (
                        <p className="channel-bind-hint">{t("channels.scannedHint")}</p>
                    )}

                    {wecomCredsMode && (
                        <form
                            className="channel-bind-form"
                            onSubmit={(e) => {
                                e.preventDefault();
                                submitWecomCreds();
                            }}
                        >
                            <p className="channel-bind-hint">{t("channels.wecomHint")}</p>
                            <TextInput
                                ref={inputRef}
                                type="text"
                                value={wecomBotId}
                                placeholder={t("channels.wecomBotIdPlaceholder")}
                                aria-label={t("channels.wecomBotId")}
                                onChange={(e) => setWecomBotId(e.target.value)}
                            />
                            <TextInput
                                type="password"
                                value={wecomSecret}
                                placeholder={t("channels.wecomSecretPlaceholder")}
                                aria-label={t("channels.wecomSecret")}
                                onChange={(e) => setWecomSecret(e.target.value)}
                            />
                            <div className="modal-actions">
                                <Button variant="ghost" onClick={onCancel}>
                                    {t("channels.cancel")}
                                </Button>
                                <Button
                                    type="submit"
                                    variant="primary"
                                    disabled={!wecomBotId.trim() || !wecomSecret.trim()}
                                >
                                    {t("channels.connect")}
                                </Button>
                            </div>
                        </form>
                    )}

                    {state === "awaiting_verify_code" && (
                        <form
                            className="channel-bind-form"
                            onSubmit={(e) => {
                                e.preventDefault();
                                void submit();
                            }}
                        >
                            <p className="channel-bind-hint">
                                {channel?.retry
                                    ? t("channels.verifyCodeRetry")
                                    : t("channels.verifyCodeHint")}
                            </p>
                            <TextInput
                                ref={inputRef}
                                type="text"
                                value={code}
                                inputMode="numeric"
                                placeholder={t("channels.verifyCodePlaceholder")}
                                onChange={(e) => setCode(e.target.value)}
                            />
                            <div className="modal-actions">
                                <Button variant="ghost" onClick={onCancel}>
                                    {t("channels.cancel")}
                                </Button>
                                <Button type="submit" variant="primary" disabled={!canSubmit}>
                                    {t("channels.submitCode")}
                                </Button>
                            </div>
                        </form>
                    )}

                    {/* `connecting` covers the gap between channels.bind resolving
                        and the first awaiting_scan push carrying the QR payload;
                        without this the dialog would render empty. `unbound` is
                        the same gap when the push has not landed at all yet. */}
                    {!error &&
                        (state === "connecting" || state === "unbound" || state === undefined) && (
                            <p className="channel-bind-hint">{t("channels.connectingHint")}</p>
                        )}

                    {state === "expired" && (
                        <p className="channel-bind-error">{t("channels.expiredHint")}</p>
                    )}

                    {state === "error" && (
                        <p className="channel-bind-error">
                            {channel?.message ?? t("channels.genericError")}
                        </p>
                    )}

                    {state === "connected" && (
                        <p className="channel-bind-hint">{t("channels.boundHint")}</p>
                    )}

                    {state !== "awaiting_verify_code" && (
                        <div className="modal-actions">
                            <Button onClick={onCancel}>{t("channels.close")}</Button>
                        </div>
                    )}
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
