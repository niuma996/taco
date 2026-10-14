/**
 * Write/delete agent definitions under `$TACO_HOME/agents`.
 *
 * The UI's agent editor writes through `agents.write` / `agents.delete`. Only
 * the taco-home directory is writable — `~/.claude/agents` and
 * `<cwd>/.taco/agents` are files the user manages by hand, and builtin agents
 * ship with the package. The writable boundary is the `filePath` the loader
 * recorded, not the name in the request, so a user definition that shadows a
 * builtin elsewhere stays read-only here.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { AgentsWriteParams } from "@taco-ai/protocol";
import { parseAgentMarkdown } from "../../agents/loadAgents.ts";
import { type AgentDefinition, DEFAULT_SUBAGENT_RUNTIME } from "../../agents/types.ts";
import { tacoHome } from "../../config/tacoHome.ts";

export class AgentWriteError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "AgentWriteError";
    }
}

export function userAgentsDir(): string {
    return join(tacoHome(), "agents");
}

/** Lowercase-alphanumeric start; the name doubles as the markdown file name. */
const AGENT_TYPE_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

/** Claude Code tool names (`Read`, `WebFetch`, `mcp__x__y`). */
const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;

/** Tools the runner always blocks; persisting them would suggest they work. */
const BLOCKED_CC_TOOLS = new Set(["AskUserQuestion"]);

/** True when the definition lives in `$TACO_HOME/agents` (the editable set). */
export function isEditableAgent(def: AgentDefinition): boolean {
    return def.filePath.startsWith(userAgentsDir());
}

function pathFor(agentType: string): string {
    const p = resolve(userAgentsDir(), `${agentType}.md`);
    if (dirname(p) !== resolve(userAgentsDir())) {
        throw new AgentWriteError(`invalid agentType: ${agentType}`);
    }
    return p;
}

function renderAgentMarkdown(p: AgentsWriteParams): string {
    // JSON-quoted scalars are valid YAML double-quoted strings, so a value with
    // a colon, quote or newline cannot break the frontmatter.
    const lines = [
        "---",
        `name: ${JSON.stringify(p.agentType)}`,
        `description: ${JSON.stringify(p.description)}`,
    ];
    if (p.whenToUse !== undefined && p.whenToUse !== "") {
        lines.push(`whenToUse: ${JSON.stringify(p.whenToUse)}`);
    }
    // The default runtime is left implicit so the file reads like any
    // hand-written agent and follows the default if it ever changes.
    if (p.runtime !== undefined && p.runtime !== DEFAULT_SUBAGENT_RUNTIME) {
        lines.push(`runtime: ${p.runtime}`);
    }
    // Claude Code settings mean nothing to the standard runtime, so they are
    // never written for it. Defaults (full preset, `auto`) stay implicit too.
    if (p.runtime === "claude-code") {
        if (p.tools !== undefined && p.tools.length > 0) {
            lines.push(`tools: ${JSON.stringify(p.tools)}`);
        }
        if (p.permissionMode !== undefined && p.permissionMode !== "auto") {
            lines.push(`permissionMode: ${p.permissionMode}`);
        }
    }
    lines.push(`maxTurns: ${p.maxTurns}`, "---", "");
    return `${lines.join("\n")}${p.systemPrompt.trimEnd()}\n`;
}

function requireEditable(def: AgentDefinition | undefined, agentType: string): void {
    if (def === undefined) throw new AgentWriteError(`agent not found: ${agentType}`);
    if (!isEditableAgent(def)) {
        throw new AgentWriteError(`agent "${agentType}" is not editable`);
    }
}

/**
 * Validate params and write `$TACO_HOME/agents/<agentType>.md`. The caller
 * (the `agents.write` handler) rescans the catalog afterwards via
 * `server.reloadAgents()`.
 */
export async function writeUserAgent(
    params: AgentsWriteParams,
    currentAgents: readonly AgentDefinition[],
): Promise<void> {
    if (!AGENT_TYPE_PATTERN.test(params.agentType)) {
        throw new AgentWriteError(
            `agentType must be lowercase kebab-case (got "${params.agentType}")`,
        );
    }
    if (!Number.isInteger(params.maxTurns) || params.maxTurns < 1) {
        throw new AgentWriteError("maxTurns must be a positive integer");
    }
    if (params.tools?.some((t) => !TOOL_NAME_PATTERN.test(t))) {
        throw new AgentWriteError("tool names may contain only letters, digits, _ and -");
    }
    if (params.tools?.some((t) => BLOCKED_CC_TOOLS.has(t))) {
        throw new AgentWriteError(
            "AskUserQuestion is not available to subagents — a subagent cannot ask the user questions",
        );
    }
    const target = params.agentType;
    if (params.previousAgentType === undefined) {
        const existing = currentAgents.find((a) => a.agentType === target);
        if (existing !== undefined) {
            throw new AgentWriteError(
                `agent type "${target}" already exists (${existing.source}) — pick another name`,
            );
        }
    } else {
        requireEditable(
            currentAgents.find((a) => a.agentType === params.previousAgentType),
            params.previousAgentType,
        );
        const collision = currentAgents.find((a) => a.agentType === target);
        if (target !== params.previousAgentType && collision !== undefined) {
            throw new AgentWriteError(
                `agent type "${target}" already exists (${collision.source}) — pick another name`,
            );
        }
    }

    await mkdir(userAgentsDir(), { recursive: true });
    const targetPath = pathFor(target);
    const tmpPath = `${targetPath}.tmp-${process.pid}`;
    await writeFile(tmpPath, renderAgentMarkdown(params), "utf-8");
    await rename(tmpPath, targetPath);
    if (params.previousAgentType !== undefined && params.previousAgentType !== target) {
        await rm(pathFor(params.previousAgentType), { force: true });
    }

    // Reparse what landed on disk so a YAML-invalid file surfaces here instead
    // of silently vanishing from the catalog.
    let written: AgentDefinition | null = null;
    try {
        written = parseAgentMarkdown(await readFile(targetPath, "utf-8"), targetPath, "user");
    } catch {
        written = null;
    }
    if (written === null) {
        await rm(targetPath, { force: true });
        throw new AgentWriteError("the file written to disk does not parse as an agent definition");
    }
}

/** Delete `$TACO_HOME/agents/<agentType>.md`. Rescanning is the caller's job. */
export async function deleteUserAgent(
    agentType: string,
    currentAgents: readonly AgentDefinition[],
): Promise<void> {
    requireEditable(
        currentAgents.find((a) => a.agentType === agentType),
        agentType,
    );
    await rm(pathFor(agentType), { force: true });
}
