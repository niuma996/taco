/**
 * FilesPreviewPane — file preview popup body.
 *
 * Render rules:
 *  - loading → "…"
 *  - block ("binary" | "unsupported" | "tooLarge") → hint + reveal-in-folder button
 *  - error → error message
 *  - markdown → rendered view (AssistantMarkdown) with a rendered/source toggle
 *  - code → shiki-highlighted, one innerHTML render (never per-line nodes)
 *  - plain text → unhighlighted <pre>
 *
 * The parent keys this component by selectedRelPath so the markdown view
 * toggle resets on file switch.
 */
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import { codeToHtml } from "shiki";
import type { PreviewBlock } from "../hooks/useFilePreview";
import { useT } from "../i18n/useI18n";
import { getExtension, imageMimeFor, shikiLangFor } from "../lib/fileTypes";
import { AssistantMarkdown } from "./AssistantMarkdown";
import { Button } from "./ui/Button";

export interface FilesPreviewPaneProps {
    selectedRelPath: string;
    content: string | null;
    block: PreviewBlock | null;
    error: string | null;
    loading: boolean;
    /** Absolute path, used by the reveal-in-folder button on blocked states. */
    absPath: string;
}

export function FilesPreviewPane(props: FilesPreviewPaneProps) {
    const { t } = useT();
    const { selectedRelPath, content, block, error, loading, absPath } = props;
    const isMarkdown = shikiLangFor(selectedRelPath) === "markdown";
    const isImage = imageMimeFor(selectedRelPath) !== null;
    const [mdView, setMdView] = useState<"rendered" | "source">("rendered");

    return (
        <div className="files-preview-pane">
            <div className="files-preview-toolbar">
                <span className="files-preview-path" title={selectedRelPath}>
                    {selectedRelPath}
                </span>
                {isMarkdown && content !== null && (
                    <div className="files-preview-view-toggle">
                        <button
                            type="button"
                            data-active={mdView === "rendered"}
                            onClick={() => setMdView("rendered")}
                        >
                            {t("files.viewRendered")}
                        </button>
                        <button
                            type="button"
                            data-active={mdView === "source"}
                            onClick={() => setMdView("source")}
                        >
                            {t("files.viewSource")}
                        </button>
                    </div>
                )}
            </div>
            <div className="files-preview-scroll">
                {loading && <div className="files-preview-empty">…</div>}
                {!loading && block !== null && (
                    <BlockedPreview block={block} fileName={selectedRelPath} absPath={absPath} />
                )}
                {!loading && block === null && error && (
                    <div className="files-preview-error">
                        {t("files.previewError")}: {error}
                    </div>
                )}
                {!loading &&
                    block === null &&
                    !error &&
                    content !== null &&
                    (isImage ? (
                        <img className="files-preview-image" src={content} alt={selectedRelPath} />
                    ) : isMarkdown && mdView === "rendered" ? (
                        <AssistantMarkdown
                            text={content}
                            className="md-assistant files-preview-md"
                        />
                    ) : (
                        <PreviewCode code={content} fileName={selectedRelPath} />
                    ))}
            </div>
        </div>
    );
}

/** Hint + reveal-in-folder button for files that can't be previewed. */
function BlockedPreview({
    block,
    fileName,
    absPath,
}: {
    block: PreviewBlock;
    fileName: string;
    absPath: string;
}) {
    const { t } = useT();
    const message =
        block === "binary"
            ? t("files.binaryFile", { ext: getExtension(fileName) || "bin" })
            : block === "tooLarge"
              ? t("files.tooLarge")
              : t("files.unsupported");
    return (
        <div className="files-preview-blocked">
            <div className="files-preview-blocked-message">{message}</div>
            <Button
                size="sm"
                onClick={() => {
                    void revealItemInDir(absPath).catch((err: unknown) => {
                        console.error("[taco] reveal file failed", err);
                    });
                }}
            >
                {t("files.revealInFolder")}
            </Button>
        </div>
    );
}

/**
 * Code body: shiki-highlighted HTML in one shot, or a plain <pre> for
 * text / as a fallback when the language grammar fails to load.
 */
function PreviewCode({ code, fileName }: { code: string; fileName: string }) {
    const lang = shikiLangFor(fileName);
    // Pair html with the code it was generated from: switching files must not
    // briefly render the previous file's highlighted html under the new name.
    const [highlighted, setHighlighted] = useState<{ code: string; html: string } | null>(null);

    useEffect(() => {
        if (lang === "text") return;
        let cancelled = false;
        codeToHtml(code, {
            lang,
            themes: { light: "github-light", dark: "github-dark" },
            defaultColor: false,
        })
            .then((h) => {
                if (!cancelled) setHighlighted({ code, html: h });
            })
            .catch(() => {
                // Unknown grammar in the shiki bundle — plain text fallback.
            });
        return () => {
            cancelled = true;
        };
    }, [code, lang]);

    const html = highlighted?.code === code ? highlighted.html : null;
    if (lang === "text" || html === null) {
        return <pre className="files-preview-plain">{code}</pre>;
    }
    // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki output is escaped token spans
    return <div className="files-preview-code" dangerouslySetInnerHTML={{ __html: html }} />;
}
