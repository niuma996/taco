#!/usr/bin/env node
/**
 * stagePlatformPackages.mjs — 把 dist/runtime/<triple>/ 拆分为独立的 npm package。
 *
 * 产物写到 `.release-staging/<name>/`（仓库外的临时目录，不进 git，
 * 不在 pnpm-workspace.yaml glob 范围内）。
 *
 * 用法:
 *   node scripts/stagePlatformPackages.mjs --version 0.1.0 [--dry-run]
 */

import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = fileURLToPath(import.meta.url);
const PKG_DIR = resolve(SCRIPT_DIR, "..", "..");
const DIST = join(PKG_DIR, "dist", "runtime");
const STAGING_ROOT = join(PKG_DIR, "..", "..", ".release-staging");

/** 6 targets → npm package name + os/cpu fields */
const PLATFORMS = [
    { triple: "aarch64-apple-darwin", name: "darwin-arm64", os: "darwin", cpu: "arm64" },
    { triple: "x86_64-apple-darwin", name: "darwin-x64", os: "darwin", cpu: "x64" },
    { triple: "x86_64-unknown-linux-gnu", name: "linux-x64", os: "linux", cpu: "x64" },
    { triple: "aarch64-unknown-linux-gnu", name: "linux-arm64", os: "linux", cpu: "arm64" },
    { triple: "x86_64-pc-windows-msvc", name: "win32-x64", os: "win32", cpu: "x64" },
    { triple: "aarch64-pc-windows-msvc", name: "win32-arm64", os: "win32", cpu: "arm64" },
];

function main() {
    const args = process.argv.slice(2);
    const dryRun = args.includes("--dry-run");
    const versionArg = args[args.indexOf("--version") + 1];

    if (!versionArg) {
        console.error("Usage: stagePlatformPackages.mjs --version <semver> [--dry-run]");
        process.exit(1);
    }
    const version = versionArg;

    const manifest = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8"));
    const repo = manifest.repository ?? "github:niuma996/taco";

    mkdirSync(STAGING_ROOT, { recursive: true });

    for (const { triple, name, os, cpu } of PLATFORMS) {
        const srcDir = join(DIST, triple);
        const outDir = join(STAGING_ROOT, `sidecar-${name}`);
        const binDir = join(outDir, "bin");
        const libDir = join(outDir, "lib");

        if (!existsSync(srcDir)) {
            console.warn(
                `[stage] SKIP ${triple} — dist/runtime/${triple} not found (build it first)`,
            );
            continue;
        }

        if (dryRun) {
            console.log(`[dry-run] would stage ${triple} → ${outDir}`);
            continue;
        }

        // Clean up old artifacts.
        mkdirSync(outDir, { recursive: true });
        mkdirSync(binDir, { recursive: true });
        mkdirSync(libDir, { recursive: true });

        // bin/: Node binary + launcher
        const nodeBin = triple.endsWith("-pc-windows-msvc")
            ? "taco-sidecar-node.exe"
            : "taco-sidecar-node";
        const launcher = triple.endsWith("-pc-windows-msvc") ? "taco-sidecar.cmd" : "taco-sidecar";

        copyFileSync(join(srcDir, "bin", nodeBin), join(binDir, nodeBin));
        if (existsSync(join(srcDir, launcher))) {
            copyFileSync(join(srcDir, launcher), join(binDir, launcher));
        }
        if (existsSync(join(srcDir, "taco-sidecar"))) {
            copyFileSync(join(srcDir, "taco-sidecar"), join(binDir, "taco-sidecar"));
        }

        // lib/: bundle + manifest
        copyFileSync(join(srcDir, "lib", "index.mjs"), join(libDir, "index.mjs"));
        copyFileSync(join(srcDir, "manifest.json"), join(outDir, "manifest.json"));

        // agents/ + skills/
        cpSync(join(srcDir, "agents"), join(outDir, "agents"), { recursive: true });
        cpSync(join(srcDir, "skills"), join(outDir, "skills"), { recursive: true });

        // per-platform package.json
        const pkg = {
            name: `@taco-ai/sidecar-${name}`,
            version,
            description: `Taco sidecar Node runtime for ${os} ${cpu}`,
            type: "module",
            os: [os],
            cpu: [cpu],
            bin: { "taco-sidecar-node": `./bin/${nodeBin}` },
            files: ["bin", "lib", "agents", "skills", "manifest.json"],
            license: "MIT",
            repository: repo,
            publishConfig: { access: "public" },
        };
        writeFileSync(join(outDir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

        console.log(`[stage] ${triple} → ${outDir}`);
    }

    if (!dryRun) {
        console.log(`\n[stage] All platform packages staged at ${STAGING_ROOT}`);
        console.log(
            `[stage] To publish: for d in .release-staging/sidecar-*; do cd "$d" && npm publish; done`,
        );
    }
}

main();
