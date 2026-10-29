/**
 * Install note for the bundled officecli skill.
 *
 * The skill body already documents the install commands, but it cannot know
 * whether the binary is on PATH. Callers prepend this when it is missing so
 * the model does not discover that via `command not found`.
 */

import { commandOnPath } from "./commandOnPath.ts";

export const OFFICECLI_MISSING_NOTE =
    "`officecli` is not on PATH. Install it, then retry:\n" +
    "macOS / Linux: `curl -fsSL https://d.officecli.ai/install.sh | bash`\n" +
    "Windows (PowerShell): `irm https://d.officecli.ai/install.ps1 | iex`\n" +
    "Verify with `officecli --version`. If it is still not found, open a new terminal.";

/** Empty unless `skillName` is the bundled officecli skill and the binary is missing. */
export function officecliMissingNote(
    skillName: string,
    lookup: (name: string) => boolean = commandOnPath,
): string {
    if (skillName !== "officecli" || lookup("officecli")) return "";
    return OFFICECLI_MISSING_NOTE;
}
