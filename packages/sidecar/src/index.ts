#!/usr/bin/env tsx
/**
 * Taco Sidecar — starts a stdio NDJSON server.
 *
 * Config loading order (later overrides earlier):
 *   1. env vars (TACO_DEFAULT_MODEL, TACO_SESSIONS_ROOT, ...)
 *   2. global config: $TACO_HOME/taco.json
 *   3. CLI args (--default-model, --system-prompt, ...)
 */

import { existsSync, mkdirSync } from "node:fs";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { defaultSessionsRoot, resolveConfig, THINKING_LEVELS, tacoHome } from "./config/config.ts";
import { loadExtensions } from "./extensions/index.ts";
import { createLogger } from "./lib/logger.ts";
import { ProviderKeyStore } from "./runtime/providerKeyStore.ts";
import { SidecarServer } from "./server/server.ts";

const log = createLogger("sidecar");

function parseThinkingLevel(raw: string | undefined): ThinkingLevel | undefined {
    if (raw === undefined) return undefined;
    if (!THINKING_LEVELS.has(raw as ThinkingLevel)) {
        throw new Error(
            `invalid --thinking-level: ${JSON.stringify(raw)} (expected one of ${[...THINKING_LEVELS].join(", ")})`,
        );
    }
    return raw as ThinkingLevel;
}

function parseArgs() {
    const args: Record<string, string> = {};
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith("--")) {
            const key = a.slice(2);
            const next = argv[i + 1];
            if (next && !next.startsWith("--")) {
                args[key] = next;
                i++;
            } else {
                args[key] = "true";
            }
        }
    }
    return args;
}

/**
 * Main entry point: resolves config, wires extensions, ensures sessions directory,
 * starts the server, and wires SIGINT/SIGTERM for graceful shutdown.
 */
async function main(): Promise<void> {
    const args = parseArgs();

    // Resolve $TACO_HOME/taco.json (default ~/.taco/taco.json)
    const cfg = resolveConfig({
        defaultModel: args["default-model"],
        sessionsRoot: args["sessions-root"],
        systemPrompt: args["system-prompt"],
        thinkingLevel: parseThinkingLevel(args["thinking-level"]),
        anthropicApiKey: args["anthropic-api-key"],
        openaiApiKey: args["openai-api-key"],
    });

    // Inject API keys into the process-level ProviderKeyStore so pi-ai can read
    // them from process.env while still allowing runtime hot-updates via settings.write
    const providerKeyStore = new ProviderKeyStore(cfg.apiKeys ?? {});

    // Load extensions: npm allowlist + $TACO_HOME/extensions + builtins
    const extensionRegistry = await loadExtensions({
        extensions: cfg.extensions ?? [],
        disabledExtensions: cfg.disabledExtensions ?? [],
    });

    // Resolve sessionsRoot and ensure the directory exists (default $TACO_HOME/sessions)
    const sessionsRoot = defaultSessionsRoot(cfg.sessionsRoot);
    if (!existsSync(sessionsRoot)) {
        mkdirSync(sessionsRoot, { recursive: true });
    }

    const server = new SidecarServer({
        sessionsRoot,
        defaultModel: cfg.defaultModel,
        defaultProvider: cfg.defaultProvider,
        systemPrompt: cfg.systemPrompt,
        defaultThinkingLevel: cfg.defaultThinkingLevel,
        compaction: cfg.compaction,
        memoryEnabled: cfg.memoryEnabled,
        extensionRegistry,
        providerKeyStore,
        customProviders: cfg.customProviders,
        channels: cfg.channels,
        mcpServers: cfg.mcpServers,
    });

    void server.start();

    const shutdown = async (sig: string) => {
        log.info(`caught ${sig}, shutting down...`);
        try {
            await server.stop();
        } finally {
            process.exit(0);
        }
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    // Tauri closes stdin to ask for graceful shutdown; without this handler
    // the process would block on readline until SIGKILL.
    process.stdin.on("end", () => void shutdown("STDIN_EOF"));

    log.info(
        `listening on stdio. sessionsRoot=${sessionsRoot}, agentConfig=${tacoHome()}/taco.json`,
    );
}

main().catch((err) => {
    log.error(`fatal: ${err?.stack ?? err}`);
    process.exit(1);
});
