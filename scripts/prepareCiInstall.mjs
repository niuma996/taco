#!/usr/bin/env node
/**
 * prepareCiInstall.mjs — make packages/sidecar/package.json installable on CI.
 *
 * The sidecar lists its per-platform runtimes (@taco-ai/sidecar-<platform>) as
 * optionalDependencies, but those packages only exist on the npm registry once
 * a sidecar-v* release has published them, so pnpm cannot record them in
 * pnpm-lock.yaml and --frozen-lockfile aborts on the specifier mismatch.
 * Stripping them before install keeps the lockfile check honest for every
 * other dependency. The edit is confined to the runner's ephemeral checkout.
 */

import { readFileSync, writeFileSync } from "node:fs";

const MANIFEST = "packages/sidecar/package.json";
const PLATFORM_PREFIX = "@taco-ai/sidecar-";

const pkg = JSON.parse(readFileSync(MANIFEST, "utf8"));
const stripped = [];

for (const name of Object.keys(pkg.optionalDependencies ?? {})) {
    if (name.startsWith(PLATFORM_PREFIX)) {
        delete pkg.optionalDependencies[name];
        stripped.push(name);
    }
}

if (stripped.length > 0) {
    writeFileSync(MANIFEST, `${JSON.stringify(pkg, null, 2)}\n`);
}

console.log(
    stripped.length > 0
        ? `[prepareCiInstall] stripped ${stripped.length}: ${stripped.join(", ")}`
        : "[prepareCiInstall] nothing to strip",
);
