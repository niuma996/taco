/**
 * Whether a bare command name is executable on PATH.
 *
 * The sidecar merges the login-shell PATH into `process.env.PATH` at startup,
 * so this sees the same binaries an agent shell would. Names with a path
 * separator are rejected — this is a command lookup, not a file open.
 */

import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

const WIN_EXTS = [".exe", ".cmd", ".bat"];

export function commandOnPath(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
    if (!name || name.includes("/") || name.includes("\\")) return false;
    const names =
        process.platform === "win32" ? [name, ...WIN_EXTS.map((ext) => `${name}${ext}`)] : [name];
    for (const dir of (env.PATH ?? "").split(delimiter)) {
        if (!dir) continue;
        for (const candidate of names) {
            try {
                accessSync(join(dir, candidate), constants.X_OK);
                return true;
            } catch {
                // Not in this directory.
            }
        }
    }
    return false;
}
