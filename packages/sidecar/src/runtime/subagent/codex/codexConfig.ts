/**
 * The user's own Codex configuration.
 *
 * A Codex subagent runs on the user's Codex setup: the provider, model, and
 * credentials under `$CODEX_HOME` (default `~/.codex`). A custom provider
 * carries its own credentials, so `codex login status` reporting "Not logged in"
 * says nothing about whether a run can work. Status reads this configuration
 * to determine whether an OpenAI login is required.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";

export interface CodexUserConfig {
    /** `$CODEX_HOME`, or `~/.codex`. */
    home: string;
    /** `model` from config.toml; absent means "whatever Codex picks". */
    model?: string;
    /** `model_provider` from config.toml; "openai" when unset. */
    provider: string;
    /** Whether the effective provider needs an OpenAI login, when known. */
    requiresOpenAiAuth?: boolean;
    /** Whether an OpenAI login or API key is present. */
    hasOpenAiCredentials: boolean;
    /** Whether config.toml was readable at all. */
    readable: boolean;
}

/** `$CODEX_HOME` when set, otherwise `~/.codex` — the CLI's own rule. */
export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
    const fromEnv = env.CODEX_HOME?.trim();
    if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
    // The CLI resolves the home directory through the platform, not through
    // $HOME: `$HOME` on POSIX, `%USERPROFILE%` on Windows. Preferring $HOME
    // everywhere would point at a different directory than the CLI reads.
    const fromHome = (process.platform === "win32" ? env.USERPROFILE : env.HOME)?.trim();
    return fromHome !== undefined && fromHome !== ""
        ? join(fromHome, ".codex")
        : join(homedir(), ".codex");
}

function isTable(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== "object") return false;
    // smol-toml hands back null-prototype objects since 1.9.
    const prototype = Object.getPrototypeOf(value);
    return prototype === null || prototype === Object.prototype;
}

/** Read the user's Codex configuration. Never throws. */
export function readCodexUserConfig(env: NodeJS.ProcessEnv = process.env): CodexUserConfig {
    const home = codexHome(env);
    const configPath = join(home, "config.toml");
    let readable = false;
    let model: string | undefined;
    let provider = "openai";
    let requiresOpenAiAuth: boolean | undefined = true;
    try {
        const text = readFileSync(configPath, "utf8");
        readable = true;
        requiresOpenAiAuth = undefined;
        const parsed = parse(text) as Record<string, unknown>;
        if (
            (parsed.model !== undefined && typeof parsed.model !== "string") ||
            (parsed.model_provider !== undefined && typeof parsed.model_provider !== "string") ||
            (parsed.model_providers !== undefined && !isTable(parsed.model_providers))
        ) {
            throw new Error("Invalid Codex configuration fields");
        }
        const configuredModel = typeof parsed.model === "string" ? parsed.model.trim() : undefined;
        if (configuredModel !== undefined && configuredModel !== "") model = configuredModel;
        const configuredProvider =
            typeof parsed.model_provider === "string" ? parsed.model_provider.trim() : undefined;
        if (configuredProvider !== undefined && configuredProvider !== "") {
            provider = configuredProvider;
        }
        const providers = parsed.model_providers as Record<string, unknown> | undefined;
        const entry =
            providers && Object.hasOwn(providers, provider) ? providers[provider] : undefined;
        if (entry !== undefined && !isTable(entry)) {
            throw new Error("Invalid Codex provider table");
        }
        const flag = entry?.requires_openai_auth;
        if (flag !== undefined && typeof flag !== "boolean") {
            throw new Error("Invalid Codex provider auth flag");
        }
        requiresOpenAiAuth = flag ?? (provider === "openai" ? true : entry ? false : undefined);
    } catch {
        // Invalid configuration stays unknown; a missing file can still use CLI login status.
    }
    const hasOpenAiCredentials =
        existsSync(join(home, "auth.json")) || (env.OPENAI_API_KEY?.trim() ?? "") !== "";
    return {
        home,
        ...(model !== undefined ? { model } : {}),
        provider,
        requiresOpenAiAuth,
        hasOpenAiCredentials,
        readable,
    };
}

/**
 * Whether a run can authenticate with the user's current configuration.
 * A custom provider that brings its own credentials needs no OpenAI login.
 */
export function codexAuthState(config: CodexUserConfig): "signed-in" | "signed-out" | "unknown" {
    if (config.requiresOpenAiAuth === undefined) return "unknown";
    if (!config.requiresOpenAiAuth) return "signed-in";
    if (config.hasOpenAiCredentials) return "signed-in";
    if (!config.readable) return "unknown";
    return "signed-out";
}
