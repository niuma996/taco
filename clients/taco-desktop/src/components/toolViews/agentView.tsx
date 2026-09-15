/**
 * agent tool view — a one-line entry point. Clicking opens the child session
 * in the right-side subagent panel; the child message stream renders there and
 * nowhere else, so there is no second copy of the same state to keep in sync.
 *
 * A call whose toolResult never landed (sidecar killed mid-run) has no
 * subSessionId; that card renders unclickable rather than leading nowhere.
 */

import { Loader2 } from "lucide-react";
import type { ReactElement } from "react";
import { useSubagent } from "../../hooks/useSubagent";
import { type ToolViewProps, toolViews } from "./registry";

interface AgentToolDetailsShape {
    subSessionId?: unknown;
    agentType?: unknown;
}

interface AgentToolArgsShape {
    subagent_type?: unknown;
    description?: unknown;
}

export function AgentToolView({ tool }: ToolViewProps): ReactElement {
    const { openInPanel } = useSubagent();
    const args = (tool.args ?? {}) as AgentToolArgsShape;
    const description = typeof args.description === "string" ? args.description : "";
    const agentTypeFromArgs = typeof args.subagent_type === "string" ? args.subagent_type : "";
    const isRunning = tool.status === "running";
    const isError = tool.status === "error";

    const details = (tool.details ?? {}) as AgentToolDetailsShape;
    const subSessionId = typeof details.subSessionId === "string" ? details.subSessionId : null;
    const agentTypeFromDetails = typeof details.agentType === "string" ? details.agentType : "";
    const agentType = agentTypeFromDetails || agentTypeFromArgs || "agent";

    return (
        <div className="agent-card" data-agent-running={isRunning ? "true" : "false"}>
            <button
                type="button"
                className="agent-card-header"
                disabled={subSessionId === null}
                onClick={() => {
                    if (subSessionId !== null) openInPanel(subSessionId);
                }}
            >
                <span className="agent-card-type">{agentType}</span>
                {description.length > 0 && <span className="agent-card-desc">{description}</span>}
                {isRunning && (
                    <span className="agent-card-running">
                        <Loader2 size={11} className="spin" aria-hidden="true" />
                        running
                    </span>
                )}
                {isError && <span className="agent-card-error">error</span>}
                {subSessionId && (
                    <span className="agent-card-subid" title={subSessionId}>
                        id {subSessionId.slice(0, 8)}
                    </span>
                )}
            </button>
        </div>
    );
}

toolViews.agent = AgentToolView;
