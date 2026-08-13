/**
 * FilesPreviewPane — right-side file preview pane.
 *
 * Render rules:
 *  - No selection → placeholder
 *  - Binary → "Binary file: X.ext (Y KB)"
 *  - Error → error message + "select another file" hint
 *  - Text → line-number gutter + body; append truncation notice if truncated
 */
import { useT } from "../i18n/useI18n";
import { getExtension } from "../lib/fileTypes";

export interface FilesPreviewPaneProps {
    selectedRelPath: string | null;
    content: string | null;
    binary: boolean;
    truncated: boolean;
    error: string | null;
    loading: boolean;
}

export function FilesPreviewPane(props: FilesPreviewPaneProps) {
    const { t } = useT();
    const { selectedRelPath, content, binary, truncated, error, loading } = props;

    if (!selectedRelPath) {
        return <div className="files-preview-empty">{t("files.previewEmpty")}</div>;
    }

    return (
        <div className="files-preview-pane">
            <div className="files-preview-path" title={selectedRelPath}>
                {selectedRelPath}
            </div>
            {loading && <div className="files-preview-empty">…</div>}
            {!loading && binary && (
                <div className="files-preview-binary">
                    {t("files.binaryFile", {
                        ext: getExtension(selectedRelPath) || "bin",
                    })}
                </div>
            )}
            {!loading && error && (
                <div className="files-preview-error">
                    {t("files.previewError")}: {error}
                </div>
            )}
            {!loading && !binary && !error && content !== null && (
                <>
                    {content.split("\n").map((line, idx) => (
                        <div key={idx} className="files-preview-line">
                            <span className="files-preview-gutter">{idx + 1}</span>
                            <span className="files-preview-text">{line || " "}</span>
                        </div>
                    ))}
                    {truncated && (
                        <div className="files-preview-truncated">{t("files.truncated")}</div>
                    )}
                </>
            )}
        </div>
    );
}
