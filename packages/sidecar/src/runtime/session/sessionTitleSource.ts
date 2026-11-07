/**
 * Session title provenance — "who last set this session's title."
 *
 * `pi.session.name` is a bare last-write-wins string with no origin tag, so
 * the auto-title logic (a 60-char truncation of the latest user message)
 * cannot tell its own writes apart from an explicit `session.rename`.
 *
 * Three sources: "placeholder" (that truncation, written on every prompt and
 * refused once a summary or rename holds the title), "summary" (the LLM title,
 * which replaces a placeholder or an earlier summary), and "user" (an explicit
 * `session.rename` — terminal, untouched by either auto-writer).
 * Keep this as a separate value record: `writeSessionFacts` replaces the whole
 * facts record, so folding provenance into it would erase it on an unrelated
 * facts write.
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
