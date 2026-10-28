// One attached file: a thumbnail for images, an icon for everything else.
// Shared by the composer (removable) and the sent message bubble (read-only).
import { convertFileSrc } from "@tauri-apps/api/core";
import { FileText, X } from "lucide-react";
import { formatBytes } from "../lib/attachments";

export interface AttachmentChipProps {
    name: string;
    size: number;
    kind: "image" | "file";
    /** Local preview (composer, before the file has a session path). */
    previewUrl?: string;
    /** Absolute path of a committed file; images preview from it. */
    path?: string;
    removeLabel?: string;
    /** Omit for a read-only chip. */
    onRemove?: () => void;
    /** Keeps the remove button visible but inert, e.g. while the composer is locked. */
    removeDisabled?: boolean;
}

export function AttachmentChip({
    name,
    size,
    kind,
    previewUrl,
    path,
    removeLabel,
    onRemove,
    removeDisabled,
}: AttachmentChipProps) {
    const src = previewUrl ?? (kind === "image" && path ? convertFileSrc(path) : undefined);
    return (
        <div className="attachment-chip" title={`${name} · ${formatBytes(size)}`}>
            {src ? (
                <img className="attachment-chip-thumb" src={src} alt="" />
            ) : (
                <span className="attachment-chip-icon" aria-hidden="true">
                    <FileText size={16} />
                </span>
            )}
            <span className="attachment-chip-text">
                <span className="attachment-chip-name">{name}</span>
                <span className="attachment-chip-size">{formatBytes(size)}</span>
            </span>
            {onRemove && (
                <button
                    type="button"
                    className="attachment-chip-remove"
                    aria-label={removeLabel}
                    disabled={removeDisabled}
                    onClick={onRemove}
                >
                    <X size={12} aria-hidden="true" />
                </button>
            )}
        </div>
    );
}
