#!/usr/bin/env node
/**
 * taco-sidecar — Node shim that locates the bundled platform binary and spawns it.
 *
 * Resolution strategy:
 *   1. Resolve the platform-specific optional dep via `require.resolve`.
 *   2. Read its `manifest.json` to locate the Node binary and bundle.
 *   3. Spawn that binary with the bundle as argument.
 *   4. On failure, exit with a clear message (not a cryptic ENOENT).
 */

const path = require("node:path");
const { spawn } = require("node:child_process");
const fs = require("node:fs");

// Detect the platform key from the optional dep names npm installs.
// Keep in sync with the six PLATFORMS in stagePlatformPackages.mjs.
const PLATFORM_KEYS = [
    "darwin-arm64",
    "darwin-x64",
    "linux-x64",
    "linux-arm64",
    "win32-x64",
    "win32-arm64",
];

function resolvePlatformPkg() {
    for (const key of PLATFORM_KEYS) {
        const pkgName = `@taco-ai/sidecar-${key}`;
        try {
            // require.resolve walks up node_modules/ until it finds the package.
            // This works whether optionalDeps are hoisted or nested.
            return { key, pkgJson: require.resolve(`${pkgName}/package.json`) };
        } catch {
            // not installed / not this platform — try next
        }
    }
    return null;
}

function resolveFromManifest(pkgJsonPath) {
    const pkgDir = path.dirname(pkgJsonPath);
    const manifestPath = path.join(pkgDir, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
        throw new Error(
            "manifest.json not found at " +
                manifestPath +
                " — the @taco-ai/sidecar platform package may be corrupt.",
        );
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return {
        nodeBin: path.join(
            pkgDir,
            "bin",
            manifest.target.endsWith("-pc-windows-msvc")
                ? "taco-sidecar-node.exe"
                : "taco-sidecar-node",
        ),
        bundle: path.join(pkgDir, "lib", "index.mjs"),
    };
}

function main() {
    const pkg = resolvePlatformPkg();
    if (!pkg) {
        console.error(
            "[taco-sidecar] ERROR: no platform-specific binary found.\n" +
                "  Make sure you ran `npm install` on a supported platform:\n" +
                "  " +
                PLATFORM_KEYS.map((k) => `@taco-ai/sidecar-${k}`).join(", ") +
                "\n" +
                "  If you believe this is a bug, please report it with your platform output:\n" +
                "  " +
                process.platform +
                "/" +
                process.arch,
        );
        process.exit(1);
    }

    const { nodeBin, bundle } = resolveFromManifest(pkg.pkgJson);
    if (!fs.existsSync(nodeBin)) {
        console.error(
            `[taco-sidecar] ERROR: Node binary not found at ${nodeBin}. ` +
                `The @taco-ai/sidecar-${pkg.key} package may be corrupt.`,
        );
        process.exit(1);
    }

    // Pass through all arguments after the script name to the bundle.
    const child = spawn(nodeBin, [bundle, ...process.argv.slice(2)], {
        // inherit stdin/stdout/stderr so the sidecar NDJSON stream passes through
        // and signals (SIGINT etc.) reach the child.
        stdio: "inherit",
        env: {
            ...process.env,
            // Let the bundle know where its resources (agents/, skills/) live.
            TACO_SIDECAR_RESOURCES: path.dirname(bundle),
        },
    });

    child.on("exit", (code, sig) => {
        // POSIX: `sig` is the terminating signal name ("SIGKILL", "SIGTERM", …);
        // map SIGKILL → 137 so callers see the conventional OOM-killer code.
        // Windows: Node never delivers POSIX-style signal names — `sig` is
        // usually `null`, occasionally a numeric Windows exception code.
        // The 137→1 fallback only fires on Unix; Windows always takes the
        // `code ?? 1` branch and surfaces the child's own exit code.
        process.exitCode = code ?? (sig === "SIGKILL" ? 137 : 1);
    });
}

main();
