/**
 * Runtime resource / version / extension root resolution — works for bundled and
 * source (tsx) builds. `import.meta.dirname` relative paths break after bundling,
 * so the three "roots" are resolved centrally here.
 * ⚠ MUST live exactly one level below src/ (src/runtime/).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tacoHome } from "../config/tacoHome.ts";

// esbuild `--define:__TACO_SIDECAR_VERSION__` injects this global at bundle time.
// Use `typeof` to narrow, not `declare const`: declare would lie to emit and
// ReferenceError on a bare reference if missing; typeof guard safely falls
// back in source form where the identifier is absent.
declare const __TACO_SIDECAR_VERSION__: unknown;

/**
 * Sidecar resource root (parent of agents/ and skills/).
 * Priority: TACO_SIDECAR_RESOURCES env > import.meta.dirname one level up.
 * Desktop release explicitly sets the env to the Tauri resource dir;
 * source/bundle default to the layout convention.
 */
export function resourceRoot(): string {
    if (process.env.TACO_SIDECAR_RESOURCES) return process.env.TACO_SIDECAR_RESOURCES;
    return join(import.meta.dirname, "..");
}

/**
 * Sidecar version, authoritatively `packages/sidecar/package.json`.
 * Bundles inline it via esbuild --define, so the `typeof` branch returns before
 * ever reaching the read below — dist ships no package.json, and that read must
 * stay unreachable there. Source form has no such identifier and reads
 * package.json, which keeps `taco/<version>` honest while running under tsx.
 */
export function sidecarVersion(): string {
    if (typeof __TACO_SIDECAR_VERSION__ === "string") return __TACO_SIDECAR_VERSION__;
    return readPackageVersion();
}

let packageVersion: string | undefined;

function readPackageVersion(): string {
    if (packageVersion !== undefined) return packageVersion;
    try {
        const pkgPath = join(import.meta.dirname, "..", "..", "package.json");
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };
        packageVersion = typeof pkg.version === "string" ? pkg.version : UNKNOWN_VERSION;
    } catch {
        packageVersion = UNKNOWN_VERSION;
    }
    return packageVersion;
}

const UNKNOWN_VERSION = "0.0.0-unknown";

/**
 * Headers that identify every taco-originated outbound HTTP request
 * (LLM chat, LLM extract, /v1/models probe). The same pair is used in:
 *
 *   - `withTacoUserAgent` (requestHeaders) — main conversation turns
 *     routed through the harness streamOptions, which pi-ai forwards
 *     as `defaultHeaders` to the OpenAI SDK (overriding its built-in
 *     User-Agent, which the sidecar bundle mangles to `Nr/JS <ver>`
 *     after minification).
 *   - `performModelsRequest` (providerModels) — `/v1/models` probes.
 *   - `MemoryExtractorImpl.extract` — fire-and-forget extraction call
 *     at turn_end; bypasses harness streamOptions entirely.
 *
 * OAuth paths deliberately skip the tag (see `withTacoUserAgent`) so
 * Anthropic's `claude-cli/<version>` identity survives and keeps
 * Claude Code's OAuth beta features enabled.
 */
export function tacoRequestHeaders(): Record<string, string> {
    const version = sidecarVersion();
    return {
        "user-agent": `taco/${version}`,
        "x-taco-sidecar-version": version,
    };
}

/**
 * Thinking level for the sidecar's background one-shot calls (dream,
 * extraction, session titles, provider probes).
 *
 * pi's simple-stream adapters send `thinking: {type:"disabled"}` when a call
 * omits `reasoning` while the model is marked as reasoning; some providers
 * reject that flag outright (MiniMax M3.1: "requires adaptive thinking" →
 * HTTP 400, which surfaces as `stopReason:"error"` and no text). Asking for
 * the cheapest level instead makes such providers answer and keeps the
 * thinking budget bounded — pi adds the budget on top of `maxTokens`, so the
 * answer room survives. Non-reasoning models get undefined: pi omits the
 * thinking parameter for them either way.
 */
export function backgroundThinkingLevel(model: { reasoning?: boolean }): "minimal" | undefined {
    return model.reasoning ? "minimal" : undefined;
}

/**
 * require resolution root for npm extensions. Bundled release ships no
 * node_modules, so the default points to `$TACO_HOME/extensions`;
 * TACO_EXTENSION_ROOT can override for tests/deploy.
 *
 * ⚠ Don't confuse with TACO_EXTENSIONS_DIR:
 *   - TACO_EXTENSION_ROOT (singular): createRequire resolution root for npm extensions
 *   - TACO_EXTENSIONS_DIR (plural): scan root for directory-form extensions
 * Both default to `$TACO_HOME/extensions` but have distinct semantics.
 */
export function extensionRequireRoot(): string {
    if (process.env.TACO_EXTENSION_ROOT) return process.env.TACO_EXTENSION_ROOT;
    return join(tacoHome(), "extensions");
}
