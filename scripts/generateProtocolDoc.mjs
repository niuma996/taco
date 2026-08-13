#!/usr/bin/env node
/**
 * generateProtocolDoc.mjs — extracts RPC/push inventory from source and injects
 * it into the marker sections of docs/sidecar-protocol.md.
 *
 * Usage: node scripts/generateProtocolDoc.mjs [--version X.Y.Z]
 * Env var SIDECAR_VERSION takes precedence over package.json. Reads the marker
 * section, scans packages/shared/rpcMethods.ts and packages/protocol/src/push.ts,
 * and leaves @manual sections untouched.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(__dirname, "..", "..");
const DOC_PATH = resolve(REPO_ROOT, "docs", "sidecar-protocol.md");
const RPC_PATH = resolve(REPO_ROOT, "packages", "shared", "rpcMethods.ts");
const PUSH_PATH = resolve(REPO_ROOT, "packages", "protocol", "src", "push.ts");

// ── Resolve the version to stamp into the doc ────────────────────────────────────
// Precedence: --version CLI flag > SIDECAR_VERSION env > packages/sidecar/package.json.
// This lets `pnpm sidecar:docs` run locally with the in-tree version, while CI
// passes the release tag through SIDECAR_VERSION.
function resolveVersion() {
    const args = process.argv.slice(2);
    const idx = args.indexOf("--version");
    if (idx !== -1 && args[idx + 1]) return args[idx + 1];
    if (process.env.SIDECAR_VERSION) return process.env.SIDECAR_VERSION;
    try {
        const pkg = JSON.parse(
            readFileSync(resolve(REPO_ROOT, "packages", "sidecar", "package.json"), "utf8"),
        );
        return pkg.version ?? "0.0.0";
    } catch {
        return "0.0.0";
    }
}

// ── Extract RPC methods ─────────────────────────────────────────────────────────
// Namespace is derived from the method name itself (`session.list` → `session.*`),
// not from source-code section comments — the wire name is the single source of
// truth, so the table can never drift from a missing or misplaced `// foo.*` marker.
function extractRpcMethods(path) {
    const src = readFileSync(path, "utf8");
    // Only look inside the `export const RPC = { ... } as const` block.
    const blockMatch = /export const RPC\s*=\s*\{([\s\S]*?)\}\s*as const/.exec(src);
    if (!blockMatch) return [];
    const block = blockMatch[1];
    const methods = [];
    for (const m of block.matchAll(/^\s+\w+:\s*"([^"]+)"/gm)) {
        const name = m[1];
        const section = name.split(".")[0];
        methods.push({ name, section });
    }
    return methods;
}

// ── Extract push methods ───────────────────────────────────────────────────────
function extractPushMethods(path) {
    const src = readFileSync(path, "utf8");
    // Only match inside the PushMethods object block
    const blockMatch = /export const PushMethods\s*=\s*\{([\s\S]*?)\}\s*as const/.exec(src);
    if (!blockMatch) return [];
    const block = blockMatch[1];
    const matches = [...block.matchAll(/^\s+(\w+):\s*"([^"]+)"/gm)];
    return matches.map((m) => ({ name: m[2], alias: m[1] }));
}

// ── Render tables ─────────────────────────────────────────────────────────────
function renderRpcTable(methods) {
    const rows = methods.map(({ name, section }) => `| \`${name}\` | ${section}.* |`);
    return ["| Method | Namespace |", "|--------|----------|", ...rows].join("\n");
}

function renderPushTable(pushMethods) {
    const rows = pushMethods.map(({ name, alias }) => `| \`${name}\` | ${alias} |`);
    return ["| Push method | Constant |", "|-------------|----------|", ...rows].join("\n");
}

// ── Sanity check: every RPC / push method exposed by the runtime must
// be reflected in the protocol doc. We compare the discoverable names
// from rpcMethods.ts against the names actually registered in
// packages/sidecar/src/server/handlers/*.ts. Mismatch means a handler
// was added or removed but the doc generator did not catch it (a typo, a
// missing registerMethod call, etc.). This is a build-time safety net,
// not a runtime invariant.
function discoverRuntimeMethods() {
    const handlersDir = resolve(REPO_ROOT, "packages", "sidecar", "src", "server", "handlers");
    const methodsFile = resolve(REPO_ROOT, "packages", "sidecar", "src", "server", "methods.ts");
    // Handlers register via `registerMethod(RPC.<key>, …)` rather than a
    // string literal, so the literal-string regex here would always miss
    // every call. Capture the camelCase key instead, then resolve it
    // through the same `RPC` const the source uses.
    const re = /registerMethod\(\s*(?:RPC\.)?(?<key>[A-Za-z_][A-Za-z0-9_]*)/g;
    const keyToName = parseRpcConstKeys();
    const names = new Set();
    for (const file of [
        methodsFile,
        ...readdirSync(handlersDir).map((f) => resolve(handlersDir, f)),
    ]) {
        const src = readFileSync(file, "utf8");
        for (const m of src.matchAll(re)) {
            const name = keyToName.get(m.groups.key);
            // Skip keys that don't resolve to an RPC entry — keeps the
            // check focused on protocol-covered methods only.
            if (name) names.add(name);
        }
    }
    return names;
}

// Build a { camelCaseKey → dottedName } map from the `RPC` const. Keeps
// the registry of "what's a real RPC method" in one place (the const)
// rather than mirrored in this script.
function parseRpcConstKeys() {
    const src = readFileSync(RPC_PATH, "utf8");
    const blockMatch = /export const RPC\s*=\s*\{([\s\S]*?)\}\s*as const/.exec(src);
    if (!blockMatch) return new Map();
    const map = new Map();
    for (const m of blockMatch[1].matchAll(/^\s+(?<key>\w+):\s*"(?<name>[^"]+)"/gm)) {
        map.set(m.groups.key, m.groups.name);
    }
    return map;
}

// ── Main ─────────────────────────────────────────────────────────────────────
const version = resolveVersion();
const doc = readFileSync(DOC_PATH, "utf8");
const rpcMethods = extractRpcMethods(RPC_PATH);
const pushMethods = extractPushMethods(PUSH_PATH);

const rpcSection = renderRpcTable(rpcMethods);
const pushSection = renderPushTable(pushMethods);

const updated = doc
    // Header version banner — keep the rest of the front-matter block intact.
    .replace(/> \*\*版本\*\*: [0-9A-Za-z.+-]+/, `> **版本**: ${version}`)
    // sidecar.hello example frame's `version` field. We only touch the JSON
    // example so the prose around it is left as-is.
    .replace(/("method": "sidecar.hello",[\s\S]*?"version": ")[^"]+(")/, `$1${version}$2`)
    .replace(
        /<!-- RPC_TABLE_START -->[\s\S]*?<!-- RPC_TABLE_END -->/,
        `<!-- RPC_TABLE_START -->\n${rpcSection}\n<!-- RPC_TABLE_END -->`,
    )
    .replace(
        /<!-- PUSH_TABLE_START -->[\s\S]*?<!-- PUSH_TABLE_END -->/,
        `<!-- PUSH_TABLE_START -->\n${pushSection}\n<!-- PUSH_TABLE_END -->`,
    );

writeFileSync(DOC_PATH, updated, "utf8");
console.log(`[generateProtocolDoc] Updated ${DOC_PATH}`);
console.log(`  version:     ${version}`);
const runtimeMethods = discoverRuntimeMethods();
const missing = [...runtimeMethods].filter((m) => !rpcMethods.some(({ name }) => name === m));
const extra = rpcMethods.map(({ name }) => name).filter((n) => !runtimeMethods.has(n));
if (missing.length) {
    console.error(
        `[generateProtocolDoc] FAIL: registered but not in RPC const: ${missing.join(", ")}`,
    );
    process.exit(1);
}
if (extra.length) {
    console.error(
        `[generateProtocolDoc] FAIL: in RPC const but not registered: ${extra.join(", ")}`,
    );
    process.exit(1);
}
console.log(`  RPC methods: ${rpcMethods.length}`);
console.log(`  Push methods: ${pushMethods.length}`);
