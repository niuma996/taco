import { harnessContext } from "../../lib/harnessContext.ts";
import type { Session } from "../pi/types.ts";
import { value } from "../pi/values.ts";
import type { AgentMessageRecord } from "./agentConversation.ts";

const AGENT_MESSAGES = value<AgentMessageRecord[]>("taco.agent.messages");

export async function readAgentMessages(session: Session): Promise<AgentMessageRecord[]> {
    return (await session.getValue(AGENT_MESSAGES, harnessContext))?.value ?? [];
}

export async function writeAgentMessages(
    session: Session,
    records: AgentMessageRecord[],
): Promise<void> {
    await session.setValue(AGENT_MESSAGES, records, harnessContext);
}
