/**
 * Boundary to the optional `@anthropic-ai/claude-agent-sdk` package and the
 * user's local `claude` CLI.
 *
 * The SDK is not a dependency of this package: installing it drags in a
 * ~240 MB platform binary, and its license (Anthropic Commercial Terms) is not
 * ours to redistribute in the bundle. It is loaded at run time instead, so the
 * types below cover only the slice of its API taco uses — checked against
 * SDK 0.3.295.
 */

import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { tacoHome } from "../../../config/tacoHome.ts";

export const CLAUDE_CODE_SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

/** Install prefix the desktop runtime looks in; it ships no node_modules of its own. */
export function claudeCodeSdkPrefix(): string {
    return join(tacoHome(), "vendor");
}

/** One content block of an SDK assistant/user message (Anthropic Messages API shape). */
export interface SdkContentBlock {
    type: string;
    text?: string;
    thinking?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
    tool_use_id?: string;
    content?: string | SdkContentBlock[];
    is_error?: boolean;
}

export type SdkMessage =
    | {
          type: "assistant";
          message: {
              id: string;
              model?: string;
              content: SdkContentBlock[];
              usage?: { input_tokens?: number; output_tokens?: number };
          };
      }
    | { type: "user"; message: { content: string | SdkContentBlock[] } }
    | {
          type: "result";
          subtype: string;
          is_error: boolean;
          result?: string;
          errors?: string[];
          num_turns: number;
      }
    | { type: "system"; subtype: string };

export type SdkPermissionMode =
    | "default"
    | "acceptEdits"
    | "bypassPermissions"
    | "plan"
    | "dontAsk"
    | "auto";

export interface SdkQueryOptions {
    pathToClaudeCodeExecutable: string;
    cwd: string;
    settingSources: Array<"user" | "project" | "local">;
    /** Omitted = Claude Code picks its own starting mode. */
    permissionMode?: SdkPermissionMode;
    /** Required by the SDK alongside `permissionMode: "bypassPermissions"`. */
    allowDangerouslySkipPermissions?: boolean;
    /** `"none"`: nothing reaches a host prompt; asks are denied in-process. */
    permissionPrompts?: "host" | "none";
    persistSession: boolean;
    strictMcpConfig: boolean;
    mcpServers: Record<string, never>;
    tools: string[] | { type: "preset"; preset: "claude_code" };
    maxTurns?: number;
    abortController: AbortController;
    env: Record<string, string>;
    systemPrompt: { type: "preset"; preset: "claude_code"; append?: string };
    stderr?: (data: string) => void;
}

export interface ClaudeAgentSdk {
    query(params: { prompt: string; options: SdkQueryOptions }): AsyncIterable<SdkMessage>;
}

/** The SDK package is not installed where the sidecar can find it. */
export class ClaudeCodeSdkMissingError extends Error {
    constructor(cause: unknown) {
        super(
            `Claude Code subagents need the optional ${CLAUDE_CODE_SDK_PACKAGE} package. ` +
                `Install it with: npm install --prefix "${claudeCodeSdkPrefix()}" --omit=optional ${CLAUDE_CODE_SDK_PACKAGE}`,
            { cause },
        );
        this.name = "ClaudeCodeSdkMissingError";
    }
}

/** No `claude` executable on PATH. */
export class ClaudeCodeCliMissingError extends Error {
    constructor() {
        super(
            "Claude Code subagents need the Claude Code CLI (`claude`) on PATH. " +
                "Install Claude Code and sign in, then retry.",
        );
        this.name = "ClaudeCodeCliMissingError";
    }
}

/**
 * Load the SDK: normal resolution first (an npm install that has it as a
 * sibling), then `$TACO_HOME/vendor/node_modules`. `--omit=optional` in the
 * install hint skips the bundled platform binary: taco runs the user's own CLI.
 *
 * The specifier is held in a variable so neither esbuild nor tsc tries to
 * resolve the package at build time.
 */
export async function loadClaudeAgentSdk(): Promise<ClaudeAgentSdk> {
    const specifier: string = CLAUDE_CODE_SDK_PACKAGE;
    try {
        return (await import(specifier)) as ClaudeAgentSdk;
    } catch {
        // fall through to the TACO_HOME install
    }
    const fallback = join(
        claudeCodeSdkPrefix(),
        "node_modules",
        ...specifier.split("/"),
        "sdk.mjs",
    );
    try {
        return (await import(pathToFileURL(fallback).href)) as ClaudeAgentSdk;
    } catch (e) {
        throw new ClaudeCodeSdkMissingError(e);
    }
}

/**
 * Locate `claude` on PATH. The sidecar merges the login-shell PATH into
 * `process.env.PATH` at startup, so nvm / Homebrew installs are visible even
 * when the sidecar was launched by launchd.
 */
export function findClaudeExecutable(env: NodeJS.ProcessEnv = process.env): string | undefined {
    const names = process.platform === "win32" ? ["claude.exe", "claude.cmd"] : ["claude"];
    for (const dir of (env.PATH ?? "").split(delimiter)) {
        if (!dir) continue;
        for (const name of names) {
            const candidate = join(dir, name);
            if (existsSync(candidate)) return candidate;
        }
    }
    return undefined;
}
