/**
 * Agent directory conventions — multi-source aggregation:
 *   1. ~/.claude/agents      (claude-compatible)
 *   2. ~/.pi/agents          (pi-compatible)
 *   3. $TACO_HOME/agents     (taco own — last-wins override)
 *   4. <cwd>/.taco/agents    (project-level, highest priority)
 *
 * ⚠ skills/agents have opposite semantics: changing order must sync the other side.
 */

import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { tacoHome } from "./config.ts";

export function defaultAgentDirs(cwd: string): string[] {
    return [
        resolvePath(homedir(), ".claude", "agents"),
        resolvePath(homedir(), ".pi", "agents"),
        resolvePath(tacoHome(), "agents"),
        resolvePath(cwd, ".taco", "agents"),
    ];
}
