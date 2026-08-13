/**
 * Extended file-operation detection for non-canonical tools.
 *
 * pi's default `extractFileOpsFromMessage` recognizes `read` / `write` / `edit`.
 * This module covers the unified `shell` tool (in-place edits via `sed -i`,
 * `>>`, `tee`, etc.) and `glob` / `grep` (literal path arguments as read-only
 * access).
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";

interface MaybeToolCallBlock {
    type?: unknown;
    toolCallId?: unknown;
    toolName?: unknown;
    args?: unknown;
}

function isToolCallBlock(b: unknown): b is {
    type: "toolCall";
    toolName: string;
    args: unknown;
} {
    if (!b || typeof b !== "object") return false;
    const o = b as MaybeToolCallBlock;
    return o.type === "toolCall" && typeof o.toolName === "string";
}

function collectAssistantBlocks(msg: AgentMessage): Array<{ toolName: string; args: unknown }> {
    const content = (msg as unknown as { content?: unknown }).content;
    if (Array.isArray(content)) {
        const out: Array<{ toolName: string; args: unknown }> = [];
        for (const b of content) {
            if (isToolCallBlock(b)) out.push({ toolName: b.toolName, args: b.args });
        }
        return out;
    }
    // toolCall may also live at the message level for some message types
    const top = (msg as unknown as { toolCall?: unknown }).toolCall;
    if (
        top &&
        typeof top === "object" &&
        isToolCallBlock({ ...(top as object), type: "toolCall" })
    ) {
        const cast = top as { toolName: string; args: unknown };
        return [{ toolName: cast.toolName, args: cast.args }];
    }
    return [];
}

/** Pull a string value from an `args` object, ignoring non-string fields. */
function getStringField(args: unknown, key: string): string | undefined {
    if (!args || typeof args !== "object") return undefined;
    const v = (args as Record<string, unknown>)[key];
    return typeof v === "string" ? v : undefined;
}

export interface ExtendedFileOps {
    /** Extra entries to merge into details.readFiles. */
    readonly extraReadFiles: string[];
    /** Extra entries to merge into details.modifiedFiles. */
    readonly extraModifiedFiles: string[];
}

// ─── helpers ────────────────────────────────────────────────────────────────

const FENCED_BACKTICKS = /```[\s\S]*?```|`[^`\n]+`/g;

/** Strip fenced code blocks so bash snippets inside code samples don't leak out. */
function stripFences(s: string): string {
    return s.replace(FENCED_BACKTICKS, " ");
}

/** Match tokens that look like a literal filesystem path. */
const PATH_TOKEN =
    /(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+|\.{1,2}\/[A-Za-z0-9_.\-/]*|\/[A-Za-z0-9_.\-/]+/g;

/** Shape used in extractBashFileOps results. */
interface BashHit {
    readonly path: string;
    readonly modifies: boolean;
}

// Pick a path token from the END of a shell command. Heuristic: split by
// whitespace and `|`, `;`, `&`, `>` (operator segments), but preserve quoted
// segments so a path like `/etc/conf.yaml` after `sed -i 's/a/b/'` survives.
function lastShellToken(cmd: string): string | undefined {
    const tokens = cmd.match(/'[^']*'|"[^"]*"|\S+/g);
    if (!tokens || tokens.length === 0) return undefined;
    let last: string | undefined;
    for (const t of tokens) {
        // Skip pure redirections / operators.
        if (/^[|>;&]+$/.test(t)) continue;
        if (t === "<") continue;
        last = t;
    }
    if (!last) return undefined;
    // Strip surrounding quotes if present.
    const m = last.match(/^['"](.*)['"]$/);
    return m ? m[1] : last;
}

// Head-pattern: command STARTS with one of these → its last token is the path.
// `>>` / `>` are NOT in this list because they often appear mid-cmd
// (e.g. `echo hi >> /tmp/out.log`) and need a separate pass below.
const WRITES_BY_LAST_TOKEN: RegExp[] = [
    /^\s*\bsed\s+-i\b/,
    /^\s*\bperl\s+-i\b/,
    /^\s*\btee\b(?:\s+-[a-zA-Z]+)*\s/,
    /^\s*\bcat\b\s*<<-?\s*['"]?\w+['"]?\s*>\s*/,
];

function isBashWriteByLastToken(cmd: string): boolean {
    for (const r of WRITES_BY_LAST_TOKEN) {
        if (r.test(cmd)) return true;
    }
    return false;
}

// Two-token commands where the LAST arg is the modified target (dst).
const CP_MV_RE = /^\s*\b(?:cp|mv)\b\s+(.+?)\s+(\S+)\s*$/;
// rm: first (and usually only) path is the target.
const RM_RE = /^\s*\brm\b\s+(.+?)\s*$/;
// `>> path` / `> path` / `>! path` / `>> path` anywhere — last token is the path.
const REDIRECT_WRITE_RE = /(?:>>|>\s*!?)\s*('([^']+)'|"([^"]+)"|(\S+))/g;

function extractBashFileOps(cmd: string): BashHit[] {
    const _out: BashHit[] = [];
    const seen = new Map<string, BashHit>();
    const push = (p: string, modifies: boolean): void => {
        if (!p || p.startsWith("-")) return;
        const existing = seen.get(p);
        if (existing) {
            // Once we know it modifies, keep modifies=true (don't downgrade).
            if (modifies) seen.set(p, { path: p, modifies: true });
            return;
        }
        seen.set(p, { path: p, modifies });
    };

    // 1) cp / mv: last token is the modified target.
    const cpMv = cmd.match(CP_MV_RE);
    if (cpMv?.[2]) push(cpMv[2], true);

    // 2) rm: first non-flag arg is the target.
    const rm = cmd.match(RM_RE);
    if (rm?.[1]) {
        const first = rm[1].split(/\s+/).find((t) => t && !t.startsWith("-"));
        if (first) push(first, true);
    }

    // 3) sed -i, perl -i, tee, cat<<> : last token is the target.
    if (isBashWriteByLastToken(cmd)) {
        const t = lastShellToken(cmd);
        if (t) push(t, true);
    }

    // 4) `>> path` / `> path` redirection (anywhere in command).
    for (const m of cmd.matchAll(REDIRECT_WRITE_RE)) {
        const target = m[2] ?? m[3] ?? m[4];
        if (target) push(target, true);
    }

    // 5) Read operators: cat / head / tail / less / more / source / .  ·
    //    `cat /etc/hosts` → read /etc/hosts.
    const READ_HEAD = /^(\s*)(cat|head|tail|less|more|source|\.)\s+(.+?)\s*$/;
    const rd = cmd.match(READ_HEAD);
    if (rd?.[3]) {
        const t = lastShellToken(rd[3]);
        if (t) push(t, false);
    }
    return [...seen.values()];
}

function extractGrepLikeArgs(args: unknown): string[] {
    const pattern = getStringField(args, "pattern") ?? getStringField(args, "query");
    const path =
        getStringField(args, "path") ?? getStringField(args, "dir") ?? getStringField(args, "cwd");
    const paths: string[] = [];
    if (path) paths.push(path);
    if (pattern) {
        // grep/glob: literals that look like files also count
        for (const m of pattern.matchAll(PATH_TOKEN)) paths.push(m[0]);
    }
    return paths;
}

// ─── main entry ──────────────────────────────────────────────────────────────

/**
 * Identify additional file operations performed by tools pi's default detector
 * (`read` / `write` / `edit`) does not look at: the unified `shell` tool
 * (heuristic), `glob`, `grep`. Returned lists are intended to be merged into
 * the compaction details alongside pi's own file lists.
 */
export function extractExtendedFileOps(messages: ReadonlyArray<AgentMessage>): ExtendedFileOps {
    const reads = new Set<string>();
    const modifies = new Set<string>();

    for (const msg of messages) {
        for (const { toolName, args } of collectAssistantBlocks(msg)) {
            if (toolName === "shell") {
                const cmd = stripFences(
                    getStringField(args, "command") ?? getStringField(args, "cmd") ?? "",
                );
                if (!cmd) continue;
                for (const hit of extractBashFileOps(cmd)) {
                    if (hit.modifies) modifies.add(hit.path);
                    else reads.add(hit.path);
                }
            } else if (toolName === "glob" || toolName === "grep") {
                for (const p of extractGrepLikeArgs(args)) {
                    if (p) reads.add(p);
                }
            }
        }
    }

    return {
        extraReadFiles: [...reads],
        extraModifiedFiles: [...modifies],
    };
}
