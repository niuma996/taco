/**
 * loadExtensions — discovers, loads, and instantiates external extensions.
 * Registers `@taco/builtin-output-redaction` first (runs before external hooks;
 * see registerBuiltinExtensions), then scans TACO_EXTENSIONS_DIR and resolves
 * npm packages from config.extensions. Each candidate: validate manifest →
 * dynamic import → factory; failures are isolated (recordFailed, continue).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tacoHome } from "../config/config.ts";
import { createLogger } from "../lib/logger.ts";
import { extensionRequireRoot } from "../runtime/runtimeResources.ts";
import { BUILTIN_EXTENSIONS } from "./builtin/manifest.ts";
import { createExtensionApi } from "./extensionApi.ts";
import { ExtensionRegistry, registerBuiltinExtensions } from "./registry.ts";
import type {
    ExtensionApiVersion,
    ExtensionManifest,
    ExtensionModule,
    ExtensionSource,
} from "./types.ts";

const log = createLogger("taco-ext");

export interface LoadedConfig {
    /** npm package names listed under taco.json's `extensions` field */
    extensions: string[];
    /** Names to skip (taco.json's `disabledExtensions`). Applies to:
     *   - `@taco/builtin-output-redaction` (via registerBuiltinExtensions)
     *   - the npm allowlist (this field).
     * Directory scan under TACO_EXTENSIONS_DIR / $TACO_HOME/extensions is
     * NOT affected by `disabledExtensions` by design — see
     * tests/extensions/loader.test.ts:115-129. */
    disabledExtensions?: string[];
}

interface Candidate {
    name: string;
    version: string;
    apiVersion: ExtensionApiVersion;
    permissions: ExtensionManifest["permissions"];
    entry: string;
    source: ExtensionSource;
    invalidReason?: string;
    description?: string;
    whenToUse?: string;
}

const SUPPORTED_API: ExtensionApiVersion = "1";

// info/debug stay hard no-ops: extension chatter is silenced by design, not
// by level. warn/error go through the shared logger.
const silentLogger = (name: string) => {
    const extLog = createLogger(`taco-ext:${name}`);
    return {
        info: (_m: string) => {},
        warn: (m: string) => extLog.warn(m),
        error: (m: string) => extLog.error(m),
        debug: (_m: string) => {},
    };
};

interface RawPackageJson {
    name?: unknown;
    version?: unknown;
    main?: unknown;
    taco?: unknown;
}

interface RawTacoManifest {
    apiVersion?: unknown;
    permissions?: unknown;
    description?: unknown;
    whenToUse?: unknown;
}

interface RawManifestPlusMain {
    manifest: ExtensionManifest;
    main?: string;
}

function readManifest(dir: string): RawManifestPlusMain | { error: string } {
    const pkgPath = join(dir, "package.json");
    if (!existsSync(pkgPath)) return { error: "package.json not found" };
    let pkg: RawPackageJson;
    try {
        pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    } catch (e) {
        return { error: `package.json parse error: ${(e as Error).message}` };
    }
    const taco = pkg.taco as RawTacoManifest | undefined;
    if (!taco || typeof taco !== "object") return { error: 'missing "taco" field' };
    if (taco.apiVersion !== SUPPORTED_API) {
        return { error: `unsupported apiVersion: ${String(taco.apiVersion)}` };
    }
    if (!Array.isArray(taco.permissions)) return { error: 'missing "taco.permissions" array' };
    return {
        manifest: {
            name: String(pkg.name ?? ""),
            version: String(pkg.version ?? ""),
            apiVersion: taco.apiVersion,
            permissions: taco.permissions as ExtensionManifest["permissions"],
            description: typeof taco.description === "string" ? taco.description : undefined,
            whenToUse: typeof taco.whenToUse === "string" ? taco.whenToUse : undefined,
        },
        main: typeof pkg.main === "string" ? pkg.main : undefined,
    };
}

function findEntry(dir: string, main: string | undefined): string | null {
    const candidates = [main, "index.js", "index.ts", "index.mjs"].filter((s): s is string =>
        Boolean(s),
    );
    for (const c of candidates) {
        const p = resolve(dir, c);
        if (existsSync(p)) return p;
    }
    return null;
}

function candidatesFromDir(root: string): Candidate[] {
    if (!existsSync(root)) return [];
    const out: Candidate[] = [];
    for (const name of readdirSync(root)) {
        const dir = join(root, name);
        try {
            if (!statSync(dir).isDirectory()) continue;
        } catch {
            continue;
        }
        const m = readManifest(dir);
        if ("error" in m) {
            out.push({
                name,
                version: "0.0.0",
                apiVersion: SUPPORTED_API,
                permissions: [],
                entry: "__invalid__",
                source: "external",
                invalidReason: m.error,
            });
            continue;
        }
        const entry = findEntry(dir, m.main);
        if (!entry) {
            out.push({
                name,
                version: m.manifest.version,
                apiVersion: m.manifest.apiVersion,
                permissions: m.manifest.permissions,
                entry: "__invalid__",
                source: "external",
                invalidReason: "no entry file (index.{js,ts,mjs})",
            });
            continue;
        }
        out.push({
            name,
            version: m.manifest.version,
            apiVersion: m.manifest.apiVersion,
            permissions: m.manifest.permissions,
            entry,
            source: "external",
            description: m.manifest.description,
            whenToUse: m.manifest.whenToUse,
        });
    }
    return out;
}

function candidatesFromNpm(packages: string[]): Candidate[] {
    if (packages.length === 0) return [];
    // Bundle ships without node_modules; resolve npm extensions from the
    // user-level install root (default $TACO_HOME/extensions; TACO_EXTENSION_ROOT
    // can override) — see runtimeResources.ts.
    const req = createRequire(join(extensionRequireRoot(), "package.json"));
    const out: Candidate[] = [];
    for (const name of packages) {
        // Derive package root from package.json — works for any subpath entry,
        // independent of the `main` shape.
        let pkgJsonPath: string;
        try {
            pkgJsonPath = req.resolve(`${name}/package.json`);
        } catch (e) {
            out.push({
                name,
                version: "0.0.0",
                apiVersion: SUPPORTED_API,
                permissions: [],
                entry: "__invalid__",
                source: "external",
                invalidReason: `package.json not resolvable: ${(e as Error).message}`,
            });
            continue;
        }
        const pkgDir = dirname(pkgJsonPath);
        const m = readManifest(pkgDir);
        if ("error" in m) {
            out.push({
                name,
                version: "0.0.0",
                apiVersion: SUPPORTED_API,
                permissions: [],
                entry: "__invalid__",
                source: "external",
                invalidReason: m.error,
            });
            continue;
        }
        const entry = findEntry(pkgDir, m.main);
        if (!entry) {
            out.push({
                name,
                version: m.manifest.version,
                apiVersion: m.manifest.apiVersion,
                permissions: m.manifest.permissions,
                entry: "__invalid__",
                source: "external",
                invalidReason: "no entry file (index.{js,ts,mjs})",
            });
            continue;
        }
        out.push({
            name,
            version: m.manifest.version,
            apiVersion: m.manifest.apiVersion,
            permissions: m.manifest.permissions,
            entry,
            source: "external",
            description: m.manifest.description,
            whenToUse: m.manifest.whenToUse,
        });
    }
    return out;
}

function dedupByName(candidates: Candidate[]): Candidate[] {
    const map = new Map<string, Candidate>();
    for (const c of candidates) {
        const prev = map.get(c.name);
        if (prev) {
            // design §5.1: later source overrides earlier; warn explicitly.
            log.warn(`duplicate extension "${c.name}"; later source overrides earlier`);
        }
        map.set(c.name, c);
    }
    return [...map.values()];
}

async function loadOne(registry: ExtensionRegistry, c: Candidate): Promise<void> {
    if (c.entry === "__invalid__") {
        registry.recordFailed(c.name, c.invalidReason ?? "unknown");
        return;
    }
    let mod: { default?: ExtensionModule } & Record<string, unknown>;
    try {
        const url = pathToFileURL(c.entry).href;
        mod = (await import(url)) as { default?: ExtensionModule } & Record<string, unknown>;
    } catch (e) {
        registry.recordFailed(c.name, `import failed: ${(e as Error).message}`);
        return;
    }
    const factory: ExtensionModule =
        typeof mod.default === "function" ? mod.default : (mod as unknown as ExtensionModule);
    const api = createExtensionApi(
        { name: c.name, version: c.version, apiVersion: c.apiVersion, permissions: c.permissions },
        registry,
        silentLogger(c.name),
        c.source,
    );
    try {
        await factory(api);
        // Snapshot any tag names this extension contributed before reporting,
        // so the LoadedEntry carries the extension's full contribution set.
        const tags = registry.extensionTagsFor(c.name);
        const entry: Parameters<ExtensionRegistry["recordLoaded"]>[0] = {
            name: c.name,
            version: c.version,
            source: c.source,
            permissions: c.permissions,
            description: c.description,
            whenToUse: c.whenToUse,
        };
        if (tags.length > 0) entry.tags = tags;
        registry.recordLoaded(entry);
    } catch (e) {
        registry.recordFailed(c.name, `factory threw: ${(e as Error).message}`);
    }
}

export async function loadExtensions(config: LoadedConfig): Promise<ExtensionRegistry> {
    const registry = new ExtensionRegistry();

    // Built-ins are registered before any external extensions so they appear
    // first in the toolResultHooks pipeline and can be overridden by external
    // extensions if needed.
    const disabled = new Set(config.disabledExtensions ?? []);
    await registerBuiltinExtensions(registry, disabled, BUILTIN_EXTENSIONS);

    const dirRoot = process.env.TACO_EXTENSIONS_DIR ?? join(tacoHome(), "extensions");

    // disabledExtensions applies uniformly: a builtin or npm name listed in
    // `disabledExtensions` is recorded via recordDisabled and never enters the
    // load pipeline, so it can never end up in failed/unauthorized (disabled
    // and failed are mutually exclusive by construction).
    const actual: string[] = [];
    for (const name of config.extensions) {
        if (disabled.has(name)) {
            registry.recordDisabled(name);
        } else {
            actual.push(name);
        }
    }

    const candidates = dedupByName([...candidatesFromDir(dirRoot), ...candidatesFromNpm(actual)]);
    for (const c of candidates) {
        await loadOne(registry, c);
    }
    return registry;
}
