/**
 * Session title provenance — "who last set this session's title."
 *
 * `pi.session.name` (see sessionMetadataReader.ts) is a bare last-write-wins
 * string with no origin tag, so the auto-title logic in session.prompt /
 * session.create (a 60-char truncation of the latest user message) cannot
 * tell its own writes apart from an explicit `session.rename`. Without this,
 * every subsequent prompt after a user rename clobbers it right back.
 *
 * Three sources, not two, because two different auto-writers exist and each
 * must be unwritable by the other:
 *   - "placeholder": the 60-char truncation written on every `session.prompt`
 *     until something better exists.
 *   - "summary": the LLM title (TitleSummarizer, re-derived on every completed
 *     run_end). Once set, the placeholder path must stop truncation-overwriting
 *     it on every subsequent message — a real summary is strictly better than a
 *     raw truncation of whatever the user typed most recently. A later summary
 *     may replace an earlier one; only "user" is terminal.
 *   - "user": an explicit `session.rename`. Neither auto-writer may touch it.
 *
 * Kept as its own value record rather than a field on `SessionFacts`
 * (sessionFacts.ts): `writeSessionFacts` replaces the whole record on every
 * write, so folding titleSource in there would make an unrelated facts write
 * silently reset title provenance (or vice versa).
 */

import { harnessContext } from "../../lib/harnessContext.ts";
import type { Context, Session } from "../pi/types.ts";
import { value } from "../pi/values.ts";

/** Who last wrote this session's title. See file doc for the three-way distinction. */
export type TitleSource = "placeholder" | "summary" | "user";

/** Address of the title-provenance record. One per session. */
export const SESSION_TITLE_SOURCE = value<TitleSource>("taco.session.titleSource");
/** Namespace string baked into `SESSION_TITLE_SOURCE`. The JSONL scanner matches this. */
export const SESSION_TITLE_SOURCE_NAMESPACE = SESSION_TITLE_SOURCE.namespace;

/**
 * Read who last set this session's title.
 *
 * Returns `undefined` for a session that predates this feature, or that has
 * never had its title provenance recorded. Callers treat that the same as
 * "user" (see sessionRegistry.ts) — a title of unknown origin is not safe for
 * auto-generated text to overwrite.
 */
export async function readTitleSource(
    session: Session,
    context: Context = harnessContext,
): Promise<TitleSource | undefined> {
    const stored = await session.getValue(SESSION_TITLE_SOURCE, context);
    return stored?.value;
}

/** Record who just set this session's title. */
export async function writeTitleSource(
    session: Session,
    source: TitleSource,
    context: Context = harnessContext,
): Promise<void> {
    await session.setValue(SESSION_TITLE_SOURCE, source, context);
}
