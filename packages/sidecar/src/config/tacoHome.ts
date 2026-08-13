/**
 * Root path for taco's own state — all taco-owned paths are derived from here.
 * Priority: TACO_HOME env > $HOME/.taco
 *
 * Extracted to a leaf module: both config.ts and runtimeResources.ts depend on it,
 * isolating it here avoids a config ↔ runtimeResources circular dependency.
 *
 * Blank = unset; relative paths are resolved relative to cwd — both rules must
 * stay in sync with `src-tauri/src/lib.rs`'s `resolve_taco_home`, otherwise
 * desktop.json and sessions/ end up in different directories (the two processes
 * have different cwd), even though both "use TACO_HOME".
 */

import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";

export function tacoHome(): string {
    const raw = process.env.TACO_HOME?.trim();
    if (raw) return resolvePath(raw);
    return resolvePath(homedir(), ".taco");
}
