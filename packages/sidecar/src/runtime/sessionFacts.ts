/**
 * Taco-owned session facts.
 *
 * The sidecar attaches its own durable attributes to a session: whether it is a
 * subagent, which agent type, how deep in the spawn chain, and (for forked
 * subagents) the rendered parent transcript.
 *
 * Before pi 0.85 these rode along in a free-form `metadata` bag passed to
 * `repo.create()`. 0.85 fixed the metadata shape (`id`, `createdAt`, `cwd`,
 * `parentSessionId`, plus the repo's own fields) and provides a general
 * key/value store for application state instead, so the facts moved there.
 *
 * Consequence worth knowing: values are written AFTER the session exists, not
 * atomically with creation, so a reader must tolerate their absence on a
 * session that was interrupted between the two steps. Every getter here
 * defaults rather than throwing.
 */

import { type Context, type Session, value } from "@earendil-works/pi-agent-core";
import { harnessContext } from "../lib/harnessContext.ts";

/** Durable per-session facts owned by the sidecar. */
export interface SessionFacts {
    /** "subagent" for spawned child sessions; absent/"main" for user sessions. */
    kind?: "main" | "subagent";
    /** Registered agent definition name, for subagent sessions. */
    agentType?: string;
    /** Spawn-chain depth. 0 for a user session, parent+1 for a subagent. */
    depth?: number;
    /**
     * Rendered parent transcript captured at spawn time, for `context: "fork"`
     * subagents. Persisted so a resume re-injects byte-identical context.
     */
    forkedContext?: string;
    /** Parent session id, for subagent sessions. */
    parentSessionId?: string;
    /** Parent tool-call id that spawned this session. */
    parentToolCallId?: string;
}

/** Address of the session-facts record. One per session. */
const FACTS = value<SessionFacts>("taco.session.facts");

/**
 * Read the sidecar's facts for a session.
 *
 * Returns `{}` when absent — a plain user session never writes them.
 */
export async function readSessionFacts(
    session: Session,
    context: Context = harnessContext,
): Promise<SessionFacts> {
    const stored = await session.getValue(FACTS, context);
    return stored?.value ?? {};
}

/**
 * Write the sidecar's facts for a session, replacing any previous record.
 *
 * Called once immediately after `repo.create()`. Not merged: the caller always
 * knows the complete set at spawn time.
 */
export async function writeSessionFacts(
    session: Session,
    facts: SessionFacts,
    context: Context = harnessContext,
): Promise<void> {
    await session.setValue(FACTS, facts, context);
}
