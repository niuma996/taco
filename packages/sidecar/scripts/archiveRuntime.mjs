#!/usr/bin/env node
/**
 * archiveRuntime.mjs — 把 buildRuntime.mjs 产出的 runtime 目录打包成可分发的 tar.gz / zip。
 *
 * 产物放在 packages/sidecar/dist/archives/:
 *   macOS / Linux → taco-sidecar-<version>-<triple>.tar.gz
 *   Windows       → taco-sidecar-<version>-<triple>.zip
 *
 * Host tooling requirement:
 *   - macOS / Linux: `tar` (BSD on macOS, GNU on Linux). All macOS/Linux
 *     runners ship this in /usr/bin by default.
 *   - Windows: `tar -a -cf` (PowerShell / Git for Windows ship tar.exe
 *     that supports `tar -a -cf <name>.zip …` to emit real zip archives).
 *     The default windows-2022 runner does not provide the GNU `zip`
 *     utility, so this script uses `tar -a` instead of `zip` so CI does
 *     not need an extra `choco install zip` step. Local Windows builds
 *     can still install `zip` and override `taco-archive-tool=zip` if
 *     they prefer the legacy formatter.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname, "..");
const distDir = join(pkgDir, "dist", "runtime");
const archivesDir = join(pkgDir, "dist", "archives");

const version = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version;

if (!existsSync(distDir)) {
    console.error("[archiveRuntime] no dist/runtime directory; run buildRuntime first");
    process.exit(1);
}

const triples = readdirSync(distDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

if (triples.length === 0) {
    console.error(`[archiveRuntime] no runtime subdirectories under ${distDir}`);
    process.exit(1);
}

mkdirSync(archivesDir, { recursive: true });

for (const triple of triples) {
    const archiveName = `taco-sidecar-${version}-${triple}`;
    if (triple.endsWith("darwin") || triple.endsWith("linux-gnu")) {
        const out = join(archivesDir, `${archiveName}.tar.gz`);
        // 父目录设到 distDir 内,避免归档路径含绝对前缀
        execSync(`tar -C "${distDir}" -czf "${out}" "${triple}"`, { stdio: "inherit" });
        console.log(`[archiveRuntime] ${out}`);
    } else if (triple.endsWith("msvc")) {
        const out = join(archivesDir, `${archiveName}.zip`);
        // Git for Windows ships a tar.exe that supports `tar -a -cf` to
        // emit a real zip archive; this lets the windows-2022 CI runner
        // archive without a choco install. The archive *contents* (zip
        // format) are unchanged for downstream consumers.
        execSync(`tar -a -C "${distDir}" -cf "${out}" "${triple}"`, { stdio: "inherit" });
        console.log(`[archiveRuntime] ${out}`);
    }
}
