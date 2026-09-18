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

import { harnessContext } from "../../lib/harnessContext.ts";
import { createLogger } from "../../lib/logger.ts";
import type { Context, Session } from "../pi/types.ts";
import { value } from "../pi/values.ts";

const log = createLogger("sidecar.sessionFacts");

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
export const SESSION_FACTS = value<SessionFacts>("taco.session.facts");
/** Namespace string baked into `SESSION_FACTS`. The JSONL scanner matches this. */
export const SESSION_FACTS_NAMESPACE = SESSION_FACTS.namespace;

/**
 * Read the sidecar's facts for a session.
 *
 * Returns `{}` when absent — a plain user session never writes them.
 */
export async function readSessionFacts(
    session: Session,
    context: Context = harnessContext,
): Promise<SessionFacts> {
    const stored = await session.getValue(SESSION_FACTS, context);
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
    await session.setValue(SESSION_FACTS, facts, context);
}

/**
 * Persist facts only when the session has none yet.
 *
 * Used to backfill a v3 `metadata` bag (or a header `parentSessionId`) onto a
 * session that pi just upgraded in place. Never overwrites a later, complete
 * record — a concurrent spawn that already wrote `{kind:"subagent",…}` must
 * win over a list-time reconstruction.
 */
export async function writeSessionFactsIfAbsent(
    session: Session,
    facts: SessionFacts,
    context: Context = harnessContext,
): Promise<boolean> {
    const existing = await readSessionFacts(session, context);
    if (existing.kind !== undefined || existing.parentSessionId !== undefined) return false;
    await writeSessionFacts(session, facts, context);
    return true;
}

/**
 * True when this session must stay off the user-facing list.
 *
 * Hidden if facts.kind is "subagent", or — when kind is absent — if the
 * header or facts carry a parentSessionId (create→writeSessionFacts window,
 * and v3 metadata migrated onto the value store). kind "main" always stays
 * visible. A facts-less session with no parent is a user session, including
 * every pre-0.85 conversation that never wrote facts.
 */
export function isHiddenSubagentSession(
    facts: SessionFacts,
    headerParentSessionId?: string,
): boolean {
    if (facts.kind === "subagent") return true;
    if (facts.kind === "main") return false;
    return headerParentSessionId !== undefined || facts.parentSessionId !== undefined;
}

/**
 * Parent depth for the recursion guard, tolerating the non-atomic write.
 *
 * A user session never writes facts, so `depth` is absent and the answer is
 * 0 — that is the common path, not a failure. Warn only when the parent
 * looks like a subagent (kind or parentSessionId present) yet still has no
 * depth: that is the create→writeSessionFacts window, and defaulting to 0
 * would let a depth-1 child spawn depth-1 grandchildren.
 */
export function resolveParentDepth(facts: SessionFacts, context: Record<string, unknown>): number {
    if (facts.depth !== undefined) return facts.depth;
    if (facts.kind === "subagent" || facts.parentSessionId !== undefined) {
        log.warn(
            "parent session has no depth fact; defaulting to 0 — recursion guard may be inactive",
            context,
        );
    }
    return 0;
}
