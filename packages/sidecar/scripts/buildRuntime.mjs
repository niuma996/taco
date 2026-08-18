#!/usr/bin/env node
/**
 * buildRuntime.mjs — bundles sidecar as an ESM portable Node runtime.
 * Output layout (triple = aarch64-apple-darwin):
 *   dist/runtime/aarch64-apple-darwin/
 *     bin/taco-sidecar-node    (Node binary, chmod 755)
 *     lib/index.mjs           (esbuild ESM bundle)
 *     agents/builtin/*.md      (built-in agent definitions)
 *     skills/builtin/...      (built-in skills)
 *     manifest.json           (version, node, target, sha256)
 */

import { createHash } from "node:crypto";
import {
    chmodSync,
    copyFileSync,
    cpSync,
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { assertTripleMatchesHost, currentTriple, parseTargetCli } from "./triple.mjs";

const esbuildModule = await import("esbuild");

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = resolve(SCRIPT_DIR, "..");
const REPO_ROOT = resolve(PKG_DIR, "..", "..");
const SRC_ENTRY = join(PKG_DIR, "src", "index.ts");
const SRC_AGENTS = join(PKG_DIR, "src", "agents", "builtin");
const SRC_SKILLS = join(PKG_DIR, "src", "skills", "builtin");
const DIST = join(PKG_DIR, "dist", "runtime");
const NODE_VERSION_FILE = join(REPO_ROOT, ".node-version");

/** Caller env: absolute path to writing dir + triple */
function main() {
    const args = process.argv.slice(2);
    const strict = args.includes("--strict");
    const explicitTarget = parseTargetCli(args);
    if (explicitTarget) {
        assertTripleMatchesHost(explicitTarget);
    }
    const triple = explicitTarget ?? currentTriple();
    const outDir = join(DIST, triple);
    const libDir = join(outDir, "lib");
    const binDir = join(outDir, "bin");
    mkdirSync(outDir, { recursive: true });
    mkdirSync(libDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(outDir, "agents", "builtin"), { recursive: true });
    mkdirSync(join(outDir, "skills", "builtin"), { recursive: true });

    const sidecarVersion = readSidecarVersion();
    const outfile = join(libDir, "index.mjs");

    console.log(
        `[buildRuntime] target=${triple} node=${process.version} version=${sidecarVersion}`,
    );
    esbuildModule.buildSync({
        entryPoints: [SRC_ENTRY],
        bundle: true,
        format: "esm",
        platform: "node",
        target: "node22",
        outfile,
        // ESM bundle standard require shim — `yaml` etc. CJS deps trigger
        //   "Dynamic require of "process" is not supported"
        // Injects createRequire / __filename / __dirname without touching source.
        banner: {
            js: [
                'import { createRequire as __cr } from "node:module";',
                'import { fileURLToPath as __fut } from "node:url";',
                'import { dirname as __dn } from "node:path";',
                "const require = __cr(import.meta.url);",
                "const __filename = __fut(import.meta.url);",
                "const __dirname = __dn(__filename);",
                "",
            ].join("\n"),
        },
        define: {
            // Bare `__TACO_SIDECAR_VERSION__` in source would ReferenceError;
            // esbuild `define` replaces all occurrences with the string literal, eliminating the identifier.
            __TACO_SIDECAR_VERSION__: JSON.stringify(sidecarVersion),
        },
        // Source uses explicit .ts extensions (esbuild by default strips them for `target:node`,
        // but `target:node22` keeps .ts intact — good, esbuild bundle handles .ts loading).
        loader: { ".ts": "ts" },
        minify: true,
        logLevel: "warning",
    });

    // Copy assets: agents / skills builtin — clear dest first for idempotent builds.
    // (Removing entries from src won't leave stale .md in dist; see smoke.test.ts builtin assertions).
    rmSync(join(outDir, "agents", "builtin"), { recursive: true, force: true });
    mkdirSync(join(outDir, "agents", "builtin"), { recursive: true });
    cpSync(SRC_AGENTS, join(outDir, "agents", "builtin"), { recursive: true });
    rmSync(join(outDir, "skills", "builtin"), { recursive: true, force: true });
    mkdirSync(join(outDir, "skills", "builtin"), { recursive: true });
    cpSync(SRC_SKILLS, join(outDir, "skills", "builtin"), { recursive: true });

    // Node binary: TACO_NODE_RUNTIME override > process.execPath (current process Node).
    const sourceNode = process.env.TACO_NODE_RUNTIME ?? process.execPath;
    if (!existsSync(sourceNode)) {
        throw new Error(`node source not found: ${sourceNode}`);
    }
    const nodeOut = join(binDir, nodeBinaryName(triple));
    copyFileSync(sourceNode, nodeOut);
    chmod755(nodeOut);

    // Unix launcher (mac/linux): bash shebang passes stdin/stdout directly to the Node bundle.
    if (triple.endsWith("-darwin") || triple.endsWith("-linux-gnu")) {
        const launcherPath = join(outDir, "taco-sidecar");
        // Use array join to avoid ${} in template literals being interpreted as JS interpolation.
        const lines = [
            "#!/usr/bin/env bash",
            "# taco-sidecar launcher — generated by buildRuntime.mjs",
            "set -euo pipefail",
            'DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"',
            'export TACO_SIDECAR_RESOURCES="${TACO_SIDECAR_RESOURCES:-$DIR}"',
            `exec "$DIR/bin/${nodeBinaryName(triple)}" "$DIR/lib/index.mjs" "$@"`,
            "",
        ];
        writeFileSync(launcherPath, lines.join("\n"));
        chmod755(launcherPath);
    }

    // Windows launcher (.cmd): %dp0 for relative positioning, %* to pass all args.
    if (triple.endsWith("-pc-windows-msvc")) {
        const launcherPath = join(outDir, "taco-sidecar.cmd");
        const nodeBin = nodeBinaryName(triple);
        const lines = [
            "@echo off",
            ":: taco-sidecar launcher — generated by buildRuntime.mjs",
            "setlocal",
            'set "SIDECAR_DIR=%~dp0"',
            'set "TACO_SIDECAR_RESOURCES=%SIDECAR_DIR%"',
            `"%SIDECAR_DIR%bin\\${nodeBin}" "%SIDECAR_DIR%lib\\index.mjs" %*`,
            "",
        ];
        writeFileSync(launcherPath, lines.join("\r\n"));
    }

    // manifest
    const bundleSha = sha256File(outfile);
    const nodeSha = sha256File(nodeOut);
    const pinnedVersion = readNodeVersionFile();
    const nodeVersionActual = process.version.replace(/^v/, "");
    if (pinnedVersion && pinnedVersion !== nodeVersionActual) {
        // Explicit TACO_NODE_RUNTIME override allows mismatch (--strict does not override).
        const msg =
            `[buildRuntime] ERROR: bundled node ${nodeVersionActual} != .node-version pin ${pinnedVersion}. ` +
            `Update .node-version to ${nodeVersionActual}, or set TACO_NODE_RUNTIME to override.`;
        if (strict) {
            throw new Error(msg);
        }
        console.warn(`[buildRuntime] WARNING: ${msg}`);
    }
    const manifest = {
        sidecarVersion,
        nodeVersion: nodeVersionActual,
        nodePinned: pinnedVersion ?? nodeVersionActual,
        target: triple,
        bundleSha256: bundleSha,
        runtimeSha256: nodeSha,
        // Daemon-mode detection: grep the bundle for the literal the runtime
        // gates on. We can't trust `sidecarVersion` to signal "has daemon
        // mode" because version bumps are manual; an older manifest without
        // this field is exactly the stale-bundle case `taco install` must
        // reject, so the flag's absence has to read as false.
        daemonMode: readFileSync(outfile, "utf8").includes("TACO_DAEMON_MODE"),
        builtAt: new Date().toISOString(),
    };
    writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

    console.log(`[buildRuntime] DONE ${outDir}`);
    console.log(`  bundle: ${outfile} (${bundleSha.slice(0, 12)}…)`);
    console.log(`  node:   ${nodeOut} (${nodeSha.slice(0, 12)}…)`);
    console.log(
        `  launcher: ${triple.endsWith("darwin") || triple.endsWith("linux") ? "taco-sidecar" : "(.cmd/.exe 后续补)"}`,
    );
}

function readSidecarVersion() {
    const pkg = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8"));
    return pkg.version;
}

function readNodeVersionFile() {
    try {
        return readFileSync(NODE_VERSION_FILE, "utf8").trim();
    } catch {
        return null;
    }
}

function sha256File(p) {
    const h = createHash("sha256");
    h.update(readFileSync(p));
    return h.digest("hex");
}

function chmod755(p) {
    try {
        chmodSync(p, 0o755);
    } catch {
        // Windows may lack chmod; Tauri handles it on startup — do not fail.
    }
}

function nodeBinaryName(triple) {
    return triple.endsWith("-msvc") ? "taco-sidecar-node.exe" : "taco-sidecar-node";
}

main();
