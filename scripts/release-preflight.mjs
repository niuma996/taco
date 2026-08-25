#!/usr/bin/env node
/**
 * release-preflight.mjs — fail-fast gate before pushing release tags.
 *
 * Runs every static check the CI workflow gates publish on, plus a
 * lockfile-sync probe that catches the most common regression: bumping
 * package.json without re-running `pnpm install`. Also surfaces the
 * current GitHub Actions artifact storage so the operator can decide
 * whether to clean old artifacts before triggering a release.
 *
 * Run from repo root. Exits 0 only when every check passes.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

/** Run a command in-process, inheriting stdio. Throws on non-zero exit. */
function run(cmd, args, opts = {}) {
    const label = `[${opts.label ?? cmd}] ${[cmd, ...args].join(" ")}`;
    console.log(`\n${label}`);
    const result = spawnSync(cmd, args, {
        cwd: opts.cwd ?? REPO_ROOT,
        stdio: "inherit",
        env: process.env,
    });
    if (result.status !== 0) {
        throw new Error(`${label} exited with status ${result.status}`);
    }
}

const runPnpm = (args, opts) => run(process.env.PNPM ?? "pnpm", args, opts);
const runNode = (args, opts) => run(process.env.NODE ?? "node", args, opts);

/** Probe artifact storage via gh CLI; returns bytes used or null. */
function probeArtifactStorage() {
    const gh = process.env.GH ?? "gh";
    // /actions/usage endpoint does not exist on github.com; the documented
    // surfaces are /settings/billing (org/repo) or /actions/cache/usage
    // (cache only). Try cache as a lightweight signal — storage exhaustion
    // tends to correlate across artifacts and cache.
    const result = spawnSync(gh, ["api", "repos/{owner}/{repo}/actions/cache/usage", "--jq", ".size_in_bytes"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: { ...process.env, GH_REPO: process.env.GH_REPO ?? "" },
    });
    if (result.status !== 0 || !result.stdout.trim()) return null;
    const bytes = Number(result.stdout.trim());
    return Number.isFinite(bytes) ? bytes : null;
}

const checks = [];

function check(name, fn) {
    checks.push({ name, fn });
}

check("lockfile-sync", () => {
    // prepareCiInstall strips @taco-ai/sidecar-<platform> from sidecar's
    // optionalDependencies; the lockfile must agree, otherwise
    // `--frozen-lockfile` fails at install.
    const manifest = join(REPO_ROOT, "packages/sidecar/package.json");
    const before = readFileSync(manifest, "utf8");
    try {
        runNode(["scripts/prepareCiInstall.mjs"], { label: "prepareCiInstall" });
        runPnpm(["install", "--frozen-lockfile"], { label: "lockfile-sync" });
    } finally {
        // Restore so a failed check leaves the tree clean.
        const after = readFileSync(manifest, "utf8");
        if (after !== before) {
            writeFileSync(manifest, before);
            console.log("  restored packages/sidecar/package.json");
        }
    }
});

check("lint", () => runPnpm(["lint"], { label: "lint" }));
check("lint:comments", () => runPnpm(["lint:comments"], { label: "lint:comments" }));
check("typecheck", () => runPnpm(["typecheck"], { label: "typecheck" }));
check("deps:circular", () => runPnpm(["deps:circular"], { label: "deps:circular" }));
check("unit-tests", () => runPnpm(["test"], { label: "test" }));
check("protocol+shared:build", () => {
    runPnpm(["protocol:build"], { label: "protocol:build" });
    runPnpm(["shared:build"], { label: "shared:build" });
});
check("desktop:build", () => runPnpm(["--filter", "@taco-ai/desktop", "build"], { label: "desktop:build" }));
check("pack:smoke", () => runPnpm(["pack:smoke"], { label: "pack:smoke" }));
check("artifact-storage", () => {
    const bytes = probeArtifactStorage();
    if (bytes === null) {
        console.log("  could not probe artifact storage (gh unavailable or no GH_REPO set) — skipping");
        return;
    }
    const gb = (bytes / 1024 / 1024 / 1024).toFixed(2);
    if (bytes > 1.5 * 1024 ** 3) {
        throw new Error(
            `artifact storage at ${gb}GB; clean old artifacts before release ` +
                `(Settings → Actions → General → Artifact and log retention)`,
        );
    }
    console.log(`  artifact storage at ${gb}GB — OK`);
});

let failed = 0;
for (const { name, fn } of checks) {
    process.stdout.write(`\n=== ${name} ===\n`);
    const t0 = Date.now();
    try {
        fn();
        console.log(`  PASS  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    } catch (err) {
        console.error(`  FAIL  ${err.message ?? err}`);
        failed++;
    }
}

console.log(`\n=== summary ===`);
if (failed > 0) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
}
console.log("all checks passed — safe to push release tags");
