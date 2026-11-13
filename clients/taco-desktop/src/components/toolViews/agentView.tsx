/** Agent creation and messaging share the same child-session navigation. */
import { LoaderCircle } from "lucide-react";
import type { ReactElement } from "react";
import { useSubagent } from "../../hooks/useSubagent";
import { useT } from "../../i18n/useI18n";
import { type ToolViewProps, toolViews } from "./registry";

function readString(source: unknown, key: string): string {
    if (typeof source !== "object" || source === null) return "";
    const value = (source as Record<string, unknown>)[key];
    return typeof value === "string" ? value : "";
}

function AgentSessionCard({ tool }: ToolViewProps): ReactElement {
    const { openInPanel, agentTypeFor } = useSubagent();
    const { t } = useT();
    const messaging = tool.name === "chatToAgent";
    const subSessionId =
        readString(tool.details, "subSessionId") ||
        (messaging ? readString(tool.args, "subSessionId") : "");
    const agentType =
        readString(tool.details, "agentType") ||
        readString(tool.args, "subagent_type") ||
        agentTypeFor(subSessionId);
    const description = readString(tool.args, messaging ? "prompt" : "description");
    const receiptStatus = readString(tool.details, "status");
    const status =
        receiptStatus === "aborted"
            ? "aborted"
            : tool.status === "error" || receiptStatus === "error"
              ? "error"
              : messaging && receiptStatus
                ? receiptStatus
                : tool.status === "running"
                  ? "started"
                  : "";
    const running = status === "started";
    const statusClass =
        status === "error"
            ? "agent-card-error"
            : status === "aborted"
              ? "agent-card-aborted"
              : "agent-card-running";

    return (
        <div className="agent-card" data-agent-running={running ? "true" : "false"}>
            <button
                type="button"
                className="agent-card-header"
                disabled={subSessionId === ""}
                onClick={() => {
                    if (subSessionId) openInPanel(subSessionId);
                }}
            >
                <span className="agent-card-type">
                    {agentType || (messaging ? t("subagents.message") : "agent")}
                </span>
                {description && (
                    <span className="agent-card-desc" title={description}>
                        {description}
                    </span>
                )}
                {status && (
                    <span className={`${statusClass} ui-fade-in`}>
                        {running && <LoaderCircle size={11} className="spin" aria-hidden="true" />}
                        {t(`subagents.delivery.${status}`)}
                    </span>
                )}
                {subSessionId && (
                    <span className="agent-card-subid ui-fade-in" title={subSessionId}>
                        id {subSessionId.slice(0, 8)}
                    </span>
                )}
            </button>
            {messaging && status === "error" && tool.resultText && (
                <pre className="tool-card-result">{tool.resultText.slice(0, 480)}</pre>
            )}
        </div>
    );
}

export const AgentToolView = AgentSessionCard;
export const ChatToAgentToolView = AgentSessionCard;

toolViews.agent = { summary: () => null, body: AgentToolView };
toolViews.chatToAgent = { summary: () => null, body: ChatToAgentToolView };
