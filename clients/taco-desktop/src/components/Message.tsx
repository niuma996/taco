/**
 * Message — single message renderer (user / system / tool / assistant).
 * Assistant messages contain thinking blocks (ThinkingBlock, defined here)
 * + markdown + tool cards.
 *
 * We don't render a top role label (user/assistant/tool/system text + icon)
 * — the message kind is conveyed by background color and content shape,
 * cutting visual noise.
 */

import type { CommandPermissionScope } from "@taco-ai/protocol";
import { ChevronRight } from "lucide-react";
import { memo, useEffect, useState } from "react";
import { useT } from "../i18n/useI18n";
import type { UiMessage, UiThinkingBlock, UiToolCall } from "../lib/chatUtils";
import { AssistantMarkdown } from "./AssistantMarkdown";
import { ToolCardShell } from "./ToolCardShell";
import { resolveToolView } from "./toolViews/registry";

/**
 * Standard fallback body — used when a tool name doesn't match the
 * toolViews registry. The shell (status icon / tool name / border) is
 * provided by ToolCardShell; this component only renders the result text.
 */
function ToolCardBody({ tool }: { tool: UiToolCall }) {
    const isRunning = tool.status === "running";
    if (!tool.resultText) return null;
    const cap = isRunning ? 240 : 480;
    const text =
        tool.resultText.length > cap ? `${tool.resultText.slice(0, cap)}…` : tool.resultText;
    return <pre className={`tool-card-result ${isRunning ? "streaming" : ""}`}>{text}</pre>;
}

/**
 * memo: applyEventToMessages emits a new reference only for the affected
 * message, so the rest of the list keeps referential equality. Shallow-
 * comparing `m` lets completed messages skip re-rendering during streaming,
 * avoiding per-push re-runs of the full conversation's shiki markdown
 * pipeline.
 */
export const Message = memo(function Message({
    m,
    onCommandPermission,
}: {
    m: UiMessage;
    onCommandPermission?: (
        requestId: string,
        approved: boolean,
        scope: CommandPermissionScope,
    ) => void;
}) {
    if (m.kind === "user") {
        return (
            <div className="message user">
                {m.images && m.images.length > 0 && (
                    <div className="message-images">
                        {m.images.map((img, i) => (
                            <img
                                key={`${img.mimeType}-${img.data.slice(0, 8)}-${img.data.slice(-8)}-${i}`}
                                className="message-image"
                                src={`data:${img.mimeType};base64,${img.data}`}
                                alt=""
                            />
                        ))}
                    </div>
                )}
                <div style={{ whiteSpace: "pre-wrap" }}>{m.text}</div>
            </div>
        );
    }
    if (m.kind === "system") {
        return (
            <div className="message system">
                <div style={{ whiteSpace: "pre-wrap" }}>{m.text}</div>
            </div>
        );
    }
    if (m.kind === "tool") {
        return (
            <div className="message tool">
                <div style={{ whiteSpace: "pre-wrap" }}>{m.text}</div>
            </div>
        );
    }
    return (
        <div className="message assistant">
            {m.thinking.map((b, i) => (
                <ThinkingBlock key={`${m.id}-think-${i}`} block={b} />
            ))}
            {m.text && <AssistantMarkdown text={m.text} />}
            {m.tools.map((tool) => {
                const View = resolveToolView(tool.name);
                return (
                    <ToolCardShell key={`${m.id}-${tool.id}`} tool={tool}>
                        {View ? <View tool={tool} /> : <ToolCardBody tool={tool} />}
                        <CommandPermissionActions tool={tool} onResolve={onCommandPermission} />
                    </ToolCardShell>
                );
            })}
        </div>
    );
});

function CommandPermissionActions({
    tool,
    onResolve,
}: {
    tool: UiToolCall;
    onResolve?: (requestId: string, approved: boolean, scope: CommandPermissionScope) => void;
}) {
    const { t } = useT();
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const request = (
        tool.details as
            | {
                  commandPermission?: {
                      requestId: string;
                      command: string;
                      evaluation: { risk: string; reason: string };
                  };
              }
            | undefined
    )?.commandPermission;
    if (!request || !onResolve) return null;
    if (tool.status !== "running") return null;

    // Destructive / external commands always re-prompt (evaluateCommand returns
    // "ask" before matchesRule), so persistent scopes have no effect on them.
    const persistentDisabled =
        request.evaluation.risk === "destructive" ||
        request.evaluation.risk === "externalSideEffect";

    const handle = async (approved: boolean, scope: CommandPermissionScope) => {
        setSubmitting(true);
        setError(null);
        try {
            await onResolve(request.requestId, approved, scope);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setSubmitting(false);
        }
    };

    const riskLabel = t(
        `settings.permissionsRisk${request.evaluation.risk.charAt(0).toUpperCase()}${request.evaluation.risk.slice(1)}`,
    );

    return (
        <div className="tool-card-permission">
            <div>
                {riskLabel}: {request.evaluation.reason}
            </div>
            <div className="tool-card-permission-command">{request.command}</div>
            <div className="tool-card-permission-actions">
                <button
                    type="button"
                    className="permission-allow"
                    disabled={submitting}
                    onClick={() => void handle(true, "once")}
                >
                    {submitting
                        ? t("settings.permissionsSubmitting")
                        : t("settings.permissionsAllowOnce")}
                </button>
                <button
                    type="button"
                    className="permission-allow"
                    disabled={submitting || persistentDisabled}
                    title={
                        persistentDisabled ? t("settings.permissionsPersistentDisabled") : undefined
                    }
                    onClick={() => void handle(true, "session")}
                >
                    {submitting
                        ? t("settings.permissionsSubmitting")
                        : t("settings.permissionsAllowSession")}
                </button>
                <button
                    type="button"
                    className="permission-allow"
                    disabled={submitting || persistentDisabled}
                    title={
                        persistentDisabled
                            ? t("settings.permissionsPersistentDisabled")
                            : t("settings.permissionsAlwaysAllowHint")
                    }
                    onClick={() => void handle(true, "global")}
                >
                    {submitting
                        ? t("settings.permissionsSubmitting")
                        : t("settings.permissionsAlwaysAllow")}
                </button>
                <button
                    type="button"
                    className="permission-deny"
                    disabled={submitting}
                    onClick={() => void handle(false, "once")}
                >
                    {t("settings.permissionsDeny")}
                </button>
                {error && <span className="permission-error">{error}</span>}
            </div>
        </div>
    );
}

function ThinkingBlock({ block }: { block: UiThinkingBlock }) {
    // Streaming blocks default open; historical / completed blocks default
    // closed. We layer a `userOverridden` flag on top so manual clicks always
    // win — until the block's default flips (e.g. streaming → completed), at
    // which point we clear the override and re-apply the default. A plain
    // useState would freeze the initial default and never auto-collapse when
    // the block finishes.
    const [userOverridden, setUserOverridden] = useState(false);
    const isHistorical = block.isHistorical === true;
    const isStreaming = !isHistorical && block.endedAt === undefined;
    const defaultOpen = isStreaming;
    // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — effect must re-run when the block transitions from streaming to completed so the user override resets and the block auto-collapses.
    useEffect(() => {
        setUserOverridden(false);
    }, [block.endedAt]);
    const open = userOverridden ? !defaultOpen : defaultOpen;
    const toggle = () => setUserOverridden((prev) => !prev);

    const label = (() => {
        if (block.redacted) return "Thinking (redacted)";
        if (isStreaming) return "Thinking…";
        if (isHistorical) return "Thought";
        const endedAt = block.endedAt as number;
        const seconds = (endedAt - (block.startedAt ?? endedAt)) / 1000;
        return `Thought for ${seconds.toFixed(1)}s`;
    })();

    return (
        <div className="thinking-block">
            <button type="button" className="thinking-header" onClick={toggle} aria-expanded={open}>
                <ChevronRight
                    size={11}
                    style={{
                        transform: open ? "rotate(90deg)" : undefined,
                        transition: "transform 0.1s",
                    }}
                    aria-hidden="true"
                />
                <span>{label}</span>
            </button>
            {open && !block.redacted && block.thinking.length > 0 && (
                <div className="thinking-body" style={{ whiteSpace: "pre-wrap" }}>
                    {block.thinking}
                </div>
            )}
        </div>
    );
}
