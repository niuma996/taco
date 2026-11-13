/**
 * Boundary to the optional pinned `@openai/codex-sdk` package.
 *
 * The SDK is not a dependency of this package: it downloads a large,
 * platform-specific Codex binary through optional npm dependencies and is
 * installed on demand under `$TACO_HOME/vendor`. Types below describe only the
 * slice of SDK 0.167.2 that taco uses.
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CodexApprovalPolicy, CodexSandboxMode } from "../../../agents/types.ts";
import { tacoHome } from "../../../config/tacoHome.ts";

export const CODEX_SDK_PACKAGE = "@openai/codex-sdk";
export const CODEX_SDK_VERSION = "0.167.2";

export function codexSdkPrefix(): string {
    return join(tacoHome(), "vendor");
}

export type CodexAuthState = "signed-in" | "signed-out" | "unknown";

export interface CodexUsage {
    input_tokens: number;
    cached_input_tokens: number;
    cache_write_input_tokens: number;
    output_tokens: number;
    reasoning_output_tokens: number;
}

/** Completed thread item; unknown future variants remain representable. */
export interface CodexThreadItem {
    id: string;
    type: string;
    [key: string]: unknown;
}

/** Streamed JSONL event; unknown future event types remain representable. */
export interface CodexThreadEvent {
    type: string;
    thread_id?: string;
    item?: CodexThreadItem;
    error?: { message?: string };
    message?: string;
    usage?: CodexUsage;
    [key: string]: unknown;
}

export interface CodexThreadOptions {
    model?: string;
    threadSource?: string;
    sandboxMode?: CodexSandboxMode;
    workingDirectory?: string;
    skipGitRepoCheck?: boolean;
    approvalPolicy?: CodexApprovalPolicy;
}

export interface CodexThread {
    /** Populated after the first turn starts. */
    readonly id: string | null;
    runStreamed(
        input: string,
        options?: { signal?: AbortSignal },
    ): Promise<{ events: AsyncGenerator<CodexThreadEvent> }>;
}

export interface CodexClientOptions {
    env?: Record<string, string>;
    config?: Record<string, unknown>;
    configOverrides?: string[];
}

export interface CodexClient {
    startThread(options?: CodexThreadOptions): CodexThread;
    resumeThread(id: string, options?: CodexThreadOptions): CodexThread;
}

export interface CodexSdkModule {
    Codex: new (options?: CodexClientOptions) => CodexClient;
}

export interface LoadedCodexSdk {
    module: CodexSdkModule;
    version: string;
    packageRoot: string;
    entryPath: string;
}

/** The pinned SDK package could not be loaded from either search location. */
export class CodexSdkMissingError extends Error {
    constructor(cause: unknown) {
        super(
            `Codex subagents need the optional ${CODEX_SDK_PACKAGE}@${CODEX_SDK_VERSION} package. ` +
                "Install the Codex runtime from Agents settings, then retry.",
            { cause },
        );
        this.name = "CodexSdkMissingError";
    }
}

/** The SDK loaded, but its platform-specific Codex CLI binary is absent. */
export class CodexSdkBinaryMissingError extends Error {
    constructor(cause: unknown) {
        super(
            "The Codex SDK is installed but its platform-specific Codex CLI binary is missing. " +
                "Reinstall the Codex runtime from Agents settings.",
            { cause },
        );
        this.name = "CodexSdkBinaryMissingError";
    }
}

/** A different SDK version was resolved where the pinned contract requires one version. */
export class CodexSdkVersionMismatchError extends Error {
    constructor(found: string | undefined) {
        super(
            `Codex subagents require ${CODEX_SDK_PACKAGE}@${CODEX_SDK_VERSION}; ` +
                `found ${found ?? "unknown metadata"}. Reinstall the managed runtime.`,
        );
        this.name = "CodexSdkVersionMismatchError";
    }
}

function packageRootFromEntry(entryPath: string): string {
    return dirname(dirname(entryPath));
}

function readVersion(packageRoot: string): string {
    try {
        const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
            version?: unknown;
        };
        if (typeof pkg.version !== "string" || pkg.version.length === 0) {
            throw new CodexSdkVersionMismatchError(undefined);
        }
        assertCodexSdkVersion(pkg.version);
        return pkg.version;
    } catch (error) {
        if (error instanceof CodexSdkVersionMismatchError) throw error;
        throw new CodexSdkVersionMismatchError(undefined);
    }
}

/** Pin the package version at module load rather than trusting any resolvable SDK. */
export function assertCodexSdkVersion(version: string): void {
    if (version !== CODEX_SDK_VERSION) throw new CodexSdkVersionMismatchError(version);
}

function missingSdkError(firstError: unknown): Error {
    if (firstError instanceof CodexSdkVersionMismatchError) return firstError;
    return new CodexSdkMissingError(firstError);
}

/**
 * Load the SDK from normal resolution first (development/package consumers),
 * then from the managed vendor prefix. Failed imports are not cached.
 */
export async function loadCodexSdk(): Promise<LoadedCodexSdk> {
    const specifier: string = CODEX_SDK_PACKAGE;
    try {
        const resolved = import.meta.resolve(specifier);
        const entryPath = fileURLToPath(resolved);
        const packageRoot = packageRootFromEntry(entryPath);
        return await loadCodexSdkEntry(entryPath, packageRoot);
    } catch (firstError) {
        const packageRoot = join(codexSdkPrefix(), "node_modules", ...specifier.split("/"));
        const entryPath = join(packageRoot, "dist", "index.js");
        if (!existsSync(entryPath)) throw missingSdkError(firstError);
        try {
            return await loadCodexSdkEntry(entryPath, packageRoot);
        } catch (error) {
            if (error instanceof CodexSdkVersionMismatchError) throw error;
            throw new CodexSdkMissingError(error);
        }
    }
}

/** Validate package metadata before module top-level code is allowed to execute. */
export async function loadCodexSdkEntry(
    entryPath: string,
    packageRoot: string,
    importModule: (url: string) => Promise<unknown> = (url) => import(url),
): Promise<LoadedCodexSdk> {
    const version = readVersion(packageRoot);
    const module = (await importModule(pathToFileURL(entryPath).href)) as CodexSdkModule;
    return { module, version, packageRoot, entryPath };
}

/** Construct a client and translate SDK binary-resolution failures. */
export function createCodexClient(sdk: CodexSdkModule, options: CodexClientOptions): CodexClient {
    try {
        return new sdk.Codex(options);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/optional dependency|CLI binaries|Missing optional dependency/i.test(message)) {
            throw new CodexSdkBinaryMissingError(error);
        }
        throw error;
    }
}

/** The managed JS entry that resolves the platform binary and exposes login status. */
export function resolveCodexCliEntry(packageRoot: string): string | undefined {
    try {
        const require = createRequire(join(packageRoot, "package.json"));
        const packageJson = require.resolve("@openai/codex/package.json");
        return join(dirname(packageJson), "bin", "codex.js");
    } catch {
        return undefined;
    }
}
