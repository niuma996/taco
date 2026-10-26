/**
 * Write/delete agent definitions in the two directories the editor owns:
 * `$TACO_HOME/agents` (scope `global`) and `<workspace>/.taco/agents` (scope
 * `workspace`).
 *
 * The UI's agent editor writes through `agents.write` / `agents.delete`.
 * `~/.claude/agents` and `~/.pi/agents` are files the user manages by hand,
 * and builtin agents ship with the package. The writable boundary is the
 * `filePath` the loader recorded, not the name in the request, so a user
 * definition that shadows a builtin elsewhere stays read-only here.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
    AGENT_TOOL_NAME_PATTERN,
    AGENT_TYPE_PATTERN,
    type AgentScope,
    type AgentsWriteParams,
} from "@taco-ai/protocol";
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

/**
 * Where a request's scopes resolve. `workspaceDir` is the directory whose
 * `.taco/agents` the loader scans (the execution cwd); it is absent for IM
 * conversations, which have no project to hold a definition.
 */
export interface AgentScopeContext {
    readonly workspaceDir?: string;
    /**
     * Directories a claude-code agent may be fixed to: the workspace's
     * execution cwd plus its associated directories, as they are at save time.
     */
    readonly allowedCwds?: readonly string[];
}

function agentsDirFor(scope: AgentScope, ctx: AgentScopeContext): string {
    if (scope === "global") return userAgentsDir();
    if (ctx.workspaceDir === undefined) {
        throw new AgentWriteError(
            "workspace-scoped agents need a project directory; this conversation has none",
        );
    }
    return join(ctx.workspaceDir, ".taco", "agents");
}

/** Lowercase-alphanumeric start; the name doubles as the markdown file name. */
/** Claude Code tool names (`Read`, `WebFetch`, `mcp__x__y`). */
const TOOL_NAME_PATTERN = AGENT_TOOL_NAME_PATTERN;

/** Tools the runner always blocks; persisting them would suggest they work. */
const BLOCKED_CC_TOOLS = new Set(["AskUserQuestion"]);

function isInside(dir: string, file: string): boolean {
    const rel = relative(resolve(dir), resolve(file));
    // `relative` across Windows drives returns an absolute path, not `..`.
    return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/** The editable scope a definition's file sits in, or undefined when the editor cannot touch it. */
export function agentScopeOf(
    def: AgentDefinition,
    ctx: AgentScopeContext = {},
): AgentScope | undefined {
    if (isInside(userAgentsDir(), def.filePath)) return "global";
    if (ctx.workspaceDir !== undefined && isInside(agentsDirFor("workspace", ctx), def.filePath)) {
        return "workspace";
    }
    return undefined;
}

/** True when the definition lives in a directory the editor owns. */
export function isEditableAgent(def: AgentDefinition, ctx: AgentScopeContext = {}): boolean {
    return agentScopeOf(def, ctx) !== undefined;
}

function pathFor(scope: AgentScope, agentType: string, ctx: AgentScopeContext): string {
    const dir = resolve(agentsDirFor(scope, ctx));
    const p = resolve(dir, `${agentType}.md`);
    if (dirname(p) !== dir) {
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
        if (p.cwd !== undefined) {
            lines.push(`cwd: ${JSON.stringify(p.cwd)}`);
        }
    }
    lines.push(`maxTurns: ${p.maxTurns}`, "---", "");
    return `${lines.join("\n")}${p.systemPrompt.trimEnd()}\n`;
}

/**
 * A claude-code agent's directory is chosen from the workspace directory and
 * its associations, so the editor never writes a path the user did not grant.
 * Compared after realpath so a symlink cannot smuggle in another tree.
 */
async function requireAllowedCwd(cwd: string, ctx: AgentScopeContext): Promise<void> {
    if (!isAbsolute(cwd)) throw new AgentWriteError(`cwd must be an absolute path (got "${cwd}")`);
    const real = await realpath(cwd).catch(() => undefined);
    if (real === undefined) throw new AgentWriteError(`cwd is not an existing directory: ${cwd}`);
    if (!(await stat(real)).isDirectory()) {
        throw new AgentWriteError(`cwd is not an existing directory: ${cwd}`);
    }
    for (const root of ctx.allowedCwds ?? []) {
        const realRoot = await realpath(root).catch(() => undefined);
        if (realRoot !== undefined && realRoot === real) return;
    }
    throw new AgentWriteError(
        `cwd must be the workspace directory or one of its associated directories: ${cwd}`,
    );
}

function requireEditable(
    def: AgentDefinition | undefined,
    agentType: string,
    ctx: AgentScopeContext,
): AgentScope {
    if (def === undefined) throw new AgentWriteError(`agent not found: ${agentType}`);
    const scope = agentScopeOf(def, ctx);
    if (scope === undefined) throw new AgentWriteError(`agent "${agentType}" is not editable`);
    return scope;
}

/**
 * Validate params and write `<agentType>.md` into the requested scope's
 * directory. The caller (the `agents.write` handler) rescans the catalog
 * afterwards via `server.reloadAgents()`.
 *
 * A workspace definition may shadow a global one (the loader gives the
 * project directory the highest priority); nothing else may be shadowed, and
 * a file already sitting in the target directory is never overwritten by a
 * create — the catalog only shows the winner, so the file system is the
 * authority on what a scope already holds.
 */
export async function writeUserAgent(
    params: AgentsWriteParams,
    currentAgents: readonly AgentDefinition[],
    ctx: AgentScopeContext = {},
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
    const previousType = params.previousAgentType;
    // An unchanged directory is not re-checked: a global agent fixed to
    // another workspace's directory must stay editable from here without
    // being forced onto this workspace's choices.
    const keptCwd =
        previousType !== undefined &&
        currentAgents.find((a) => a.agentType === previousType)?.cwd === params.cwd;
    if (params.runtime === "claude-code" && params.cwd !== undefined && !keptCwd) {
        await requireAllowedCwd(params.cwd, ctx);
    }
    const previousScope =
        previousType === undefined
            ? undefined
            : requireEditable(
                  currentAgents.find((a) => a.agentType === previousType),
                  previousType,
                  ctx,
              );
    const scope = params.scope ?? previousScope ?? "global";
    const targetPath = pathFor(scope, target, ctx);
    const previousPath =
        previousType !== undefined && previousScope !== undefined
            ? pathFor(previousScope, previousType, ctx)
            : undefined;

    // `existing` is the entry in effect for the target name. When the target
    // name is the one being edited it is the definition being replaced.
    const existing = currentAgents.find((a) => a.agentType === target);
    if (existing !== undefined && target !== previousType) {
        const shadowsGlobal = scope === "workspace" && agentScopeOf(existing, ctx) === "global";
        if (!shadowsGlobal) {
            throw new AgentWriteError(
                `agent type "${target}" already exists (${existing.source}) — pick another name`,
            );
        }
    }
    if (targetPath !== previousPath && existsSync(targetPath)) {
        throw new AgentWriteError(
            `agent type "${target}" already exists in the ${scope} directory — pick another name`,
        );
    }

    await mkdir(dirname(targetPath), { recursive: true });
    const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await writeFile(tmpPath, renderAgentMarkdown(params), "utf-8");
    await rename(tmpPath, targetPath);
    if (previousPath !== undefined && previousPath !== targetPath) {
        await rm(previousPath, { force: true });
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

/** Delete the definition in effect for `agentType`. Rescanning is the caller's job. */
export async function deleteUserAgent(
    agentType: string,
    currentAgents: readonly AgentDefinition[],
    ctx: AgentScopeContext = {},
): Promise<void> {
    const scope = requireEditable(
        currentAgents.find((a) => a.agentType === agentType),
        agentType,
        ctx,
    );
    await rm(pathFor(scope, agentType, ctx), { force: true });
}
