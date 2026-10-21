/**
 * The config tools as deferred-tool candidates.
 *
 * Registered alongside the MCP candidates so they appear in the
 * `<deferred_tools>` listing and are loaded on demand via `addTools`. They
 * are not resident: most sessions never touch the global config, and their
 * schema and description would otherwise cost tokens on every request.
 *
 * The boundary — local main session only — is enforced inside the tools
 * (see `configToolsAllowed`), not here: a candidate is workspace-level, so
 * it cannot know which session will load it.
 */

import type { ToolCandidate } from "../runtime/harness/deferredToolRegistry.ts";
import { createConfigTools } from "./config.ts";

export function configToolCandidates(): ToolCandidate[] {
    return [
        {
            name: "configGet",
            summary:
                "Read the global taco configuration (default model, thinking level, system " +
                "prompt, command permissions). Secrets come back masked.",
            loading: "deferred",
            source: "builtin",
            load: async () => createConfigTools().configGet,
        },
        {
            name: "configPatch",
            summary:
                "Change the global taco configuration. The user approves each change " +
                "before it is written. API keys and channel credentials are not settable here.",
            loading: "deferred",
            source: "builtin",
            load: async () => createConfigTools().configPatch,
        },
    ];
}
