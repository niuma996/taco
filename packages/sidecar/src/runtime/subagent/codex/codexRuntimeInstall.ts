/** Managed installation and non-paid status probing for the Codex SDK. */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import type { AgentsInstallRuntimeResult, AgentsRuntimeStatusResult } from "@taco-ai/protocol";
import { scrubbedProcessEnv } from "../../models/providerKeyStore.ts";
import { type CodexUserConfig, codexAuthState, readCodexUserConfig } from "./codexConfig.ts";
import {
    CODEX_SDK_PACKAGE,
    CODEX_SDK_VERSION,
    type CodexAuthState,
    type CodexClient,
    CodexSdkBinaryMissingError,
    codexSdkPrefix,
    createCodexClient,
    type LoadedCodexSdk,
    loadCodexSdk,
    resolveCodexCliEntry,
} from "./codexSdk.ts";

export interface CodexRuntimeStatusDeps {
    loadSdk?: () => Promise<LoadedCodexSdk>;
    createClient?: (loaded: LoadedCodexSdk) => CodexClient;
    resolveCliEntry?: (packageRoot: string) => string | undefined;
    readAuth?: (cliEntry: string) => Promise<CodexAuthState>;
    /** The user's own Codex configuration; a seam so tests stay hermetic. */
    readUserConfig?: () => CodexUserConfig;
}

export interface CodexRuntimeInstallDeps {
    /** Test seam at the executable boundary; production uses execFile. */
    runNpm?: (
        command: string,
        args: string[],
        options: { cwd: string; env: Record<string, string> },
    ) => Promise<void>;
    probe?: () => Promise<AgentsRuntimeStatusResult>;
}

/**
 * Quote one command token for a terminal, quoting only when the token needs
 * it. The rendered command is meant to be pasted into a shell, so the noisy
 * "quote everything" form is avoided — but a path with a space still has to
 * survive the copy.
 */
export function quoteCommandToken(value: string): string {
    if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
    if (!/["$`]/.test(value)) return `"${value}"`;
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Terminal install command. Works even when the sidecar process cannot find npm. */
export function codexManualInstallCommand(): string {
    return ["npm", ...codexNpmInstallArgs(codexSdkPrefix())].map(quoteCommandToken).join(" ");
}

/** Login command for the managed CLI, not a `codex` binary on PATH. */
export function codexLoginCommand(cliEntry: string): string {
    return `${quoteCommandToken(process.execPath)} ${quoteCommandToken(cliEntry)} login`;
}

/**
 * Actionable failure for a missing SDK or platform binary. Includes the
 * terminal command because the Agents page may not be open when a chat spawn fails.
 */
export function codexRuntimeUnavailableMessage(error?: unknown): string {
    const command = codexManualInstallCommand();
    const binaryMissing = error instanceof CodexSdkBinaryMissingError;
    const npm = resolveNpm();
    if (binaryMissing) {
        return (
            "The Codex SDK is installed but its platform-specific CLI binary is missing. " +
            (npm
                ? "Reinstall it from Agents, or run this command in a terminal:\n"
                : "npm is not available to this app. Install Node.js with npm, then run:\n") +
            command
        );
    }
    return (
        "The managed Codex runtime is not installed. " +
        (npm
            ? "Open Agents and install it there, or run this command in a terminal:\n"
            : "npm is not available to this app. Install Node.js with npm, then run this command in a terminal:\n") +
        command
    );
}

/** Parse `codex login status` without treating arbitrary output as signed in. */
export function parseCodexLoginStatus(output: string): CodexAuthState {
    const text = output.toLowerCase();
    if (/not logged in|not signed in|not authenticated|signed out|logged out/.test(text)) {
        return "signed-out";
    }
    if (/\blogged in\b|\bsigned in\b/.test(text)) return "signed-in";
    return "unknown";
}

export function readCodexLoginState(cliEntry: string): Promise<CodexAuthState> {
    return new Promise((resolve) => {
        try {
            execFile(
                process.execPath,
                [cliEntry, "login", "status"],
                {
                    env: scrubbedProcessEnv(),
                    windowsHide: true,
                    timeout: 10_000,
                    maxBuffer: 256 * 1024,
                },
                (error, stdout, stderr) => {
                    const text = `${stdout ?? ""}\n${stderr ?? ""}`;
                    if (text.trim() !== "") {
                        resolve(parseCodexLoginStatus(text));
                        return;
                    }
                    void error;
                    resolve("unknown");
                },
            );
        } catch {
            resolve("unknown");
        }
    });
}

/** Resolve installation/auth facts without a model call. Never throws. */
export async function getCodexRuntimeStatus(
    deps: CodexRuntimeStatusDeps = {},
): Promise<AgentsRuntimeStatusResult> {
    const readUserConfig = deps.readUserConfig ?? (() => readCodexUserConfig(scrubbedProcessEnv()));
    try {
        const loaded = await (deps.loadSdk ?? loadCodexSdk)();
        const client = deps.createClient
            ? deps.createClient(loaded)
            : createCodexClient(loaded.module, { env: scrubbedProcessEnv() });
        void client;
        const cliEntry = (deps.resolveCliEntry ?? resolveCodexCliEntry)(loaded.packageRoot);
        const config = readUserConfig();
        // The user's own configuration decides: a custom provider brings its
        // own credentials, so an absent OpenAI login says nothing. Only when
        // the config cannot be read at all does the managed CLI get the vote.
        let auth: CodexAuthState = codexAuthState(config);
        if (auth === "unknown" && !config.readable && cliEntry) {
            try {
                auth = await (deps.readAuth ?? readCodexLoginState)(cliEntry);
            } catch {
                auth = "unknown";
            }
        }
        return {
            runtime: "codex",
            installed: true,
            version: loaded.version,
            auth,
            installer: resolveNpm() ? "available" : "missing",
            installCommand: codexManualInstallCommand(),
            ...(config.model !== undefined ? { model: config.model } : {}),
            provider: config.provider,
            ...(auth === "signed-out" && cliEntry
                ? { loginCommand: codexLoginCommand(cliEntry) }
                : {}),
        };
    } catch {
        const config = readUserConfig();
        return {
            runtime: "codex",
            installed: false,
            auth: codexAuthState(config),
            installer: resolveNpm() ? "available" : "missing",
            installCommand: codexManualInstallCommand(),
            ...(config.model !== undefined ? { model: config.model } : {}),
            provider: config.provider,
        };
    }
}

let installChain: Promise<void> = Promise.resolve();
const installing = new Map<string, Promise<AgentsInstallRuntimeResult>>();

/** Install exactly the pinned SDK; concurrent callers share one install. */
export function installCodexRuntime(
    deps: CodexRuntimeInstallDeps = {},
): Promise<AgentsInstallRuntimeResult> {
    const prefix = codexSdkPrefix();
    const pending = installing.get(prefix);
    if (pending) return pending;
    const next = installChain.then(async () => {
        mkdirSync(prefix, { recursive: true });
        const npm = findNpm();
        await (deps.runNpm ?? runNpm)(
            npm.command,
            [...npm.argsPrefix, ...codexNpmInstallArgs(prefix)],
            { cwd: prefix, env: scrubbedProcessEnv() },
        );
        const status = await (deps.probe ?? getCodexRuntimeStatus)();
        if (!status.installed) {
            throw new Error(
                "Codex runtime installation completed but the SDK or platform binary did not resolve.",
            );
        }
        return {
            runtime: "codex" as const,
            ok: true as const,
            version: status.version ?? CODEX_SDK_VERSION,
        };
    });
    installing.set(prefix, next);
    installChain = next.then(
        () => undefined,
        () => undefined,
    );
    void next.finally(() => installing.delete(prefix)).catch(() => undefined);
    return next;
}

export function resolveNpm(): { command: string; argsPrefix: string[] } | undefined {
    const paths = [dirname(process.execPath), ...(process.env.PATH ?? "").split(delimiter)];
    const candidates = paths.flatMap((path) => [
        join(path, "node_modules/npm/bin/npm-cli.js"),
        join(path, "../lib/node_modules/npm/bin/npm-cli.js"),
        join(path, "../node_modules/npm/bin/npm-cli.js"),
    ]);
    for (const path of paths) {
        const npm = join(path, "npm");
        if (!existsSync(npm)) continue;
        const actual = realpathSync(npm);
        if (actual.endsWith("npm-cli.js")) candidates.push(actual);
    }
    const npmCli = candidates.find(existsSync);
    if (npmCli) return { command: process.execPath, argsPrefix: [npmCli] };
    if (process.platform === "win32") {
        const npmCmd = paths.map((path) => join(path, "npm.cmd")).find(existsSync);
        if (npmCmd) return windowsNpmFallback(undefined, npmCmd);
    }
    const npmShim = paths.map((path) => join(path, "npm")).find(existsSync);
    if (!npmShim) return undefined;
    return { command: npmShim, argsPrefix: [] };
}

function findNpm(): { command: string; argsPrefix: string[] } {
    const npm = resolveNpm();
    if (!npm) {
        throw new Error(codexRuntimeUnavailableMessage());
    }
    return npm;
}

/** Node cannot execFile a `.cmd` shim directly; route it through ComSpec. */
export function windowsNpmFallback(
    comspec: string | undefined = process.env.ComSpec,
    npmCommand = "npm",
): {
    command: string;
    argsPrefix: string[];
} {
    return {
        command: comspec?.trim() || "cmd.exe",
        argsPrefix: ["/d", "/s", "/c", npmCommand],
    };
}

export function codexNpmInstallArgs(prefix: string): string[] {
    return [
        "install",
        "--prefix",
        prefix,
        "--include=optional",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        `${CODEX_SDK_PACKAGE}@${CODEX_SDK_VERSION}`,
    ];
}

async function runNpm(
    command: string,
    args: string[],
    options: { cwd: string; env: Record<string, string> },
): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        execFile(
            command,
            args,
            {
                ...options,
                windowsHide: true,
                timeout: 30 * 60_000,
                maxBuffer: 4 * 1024 * 1024,
            },
            (error, _stdout, stderr) => {
                if (error) {
                    reject(
                        new Error(
                            `Codex runtime installation failed: ${stderr.trim() || error.message}`,
                        ),
                    );
                } else resolve();
            },
        );
    });
}
