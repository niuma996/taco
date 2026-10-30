/**
 * The first-party deferred-tool candidates a workspace registers.
 *
 * One list for the server's registry and for the `fileAccess.ts` consistency
 * test, so a new built-in candidate cannot reach production without being
 * checked for undeclared path arguments.
 */

import type { ToolCandidate } from "../runtime/harness/deferredToolRegistry.ts";
import { configToolCandidates } from "./configCandidates.ts";
import { pdfToolCandidates } from "./pdfCandidates.ts";
import { sessionHistoryToolCandidates } from "./sessionSearch.ts";

export function builtinToolCandidates(scopeKind: "local" | "im"): ToolCandidate[] {
    return [
        ...configToolCandidates(),
        // Registered for IM workspaces too: the policy decides whether
        // they are offered, and it can change while the workspace lives.
        ...pdfToolCandidates(),
        // Not offered to IM workspaces: a third party drives those, and
        // the transcripts are the user's private history.
        ...(scopeKind === "im" ? [] : sessionHistoryToolCandidates()),
    ];
}
