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
import { dirname, resolve } from "node:path";
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

/**
 * Probe artifact + cache storage via gh CLI. GitHub does not expose a
 * repo-level "usage / quota" endpoint on REST — the Settings → Actions
 * page is the only canonical source — so we approximate by summing
 * artifacts and cache usage. Returns null on any failure (gh missing,
 * GH_REPO unset, etc).
 */
function probeArtifactStorage() {
    const gh = process.env.GH ?? "gh";
    const env = { ...process.env, GH_REPO: process.env.GH_REPO ?? "" };

    const artifacts = spawnSync(
        gh,
        [
            "api",
            "repos/{owner}/{repo}/actions/artifacts",
            "--paginate",
            "--jq",
            "[.artifacts[].size_in_bytes] | add // 0",
        ],
        { cwd: REPO_ROOT, encoding: "utf8", env },
    );
    const cache = spawnSync(
        gh,
        ["api", "repos/{owner}/{repo}/actions/cache/usage", "--jq", ".active_caches_size_in_bytes"],
        { cwd: REPO_ROOT, encoding: "utf8", env },
    );
    if (artifacts.status !== 0 || cache.status !== 0) return null;
    const aBytes = Number(artifacts.stdout.trim()) || 0;
    const cBytes = Number(cache.stdout.trim()) || 0;
    return { artifacts: aBytes, cache: cBytes, total: aBytes + cBytes };
}

const checks = [];

function check(name, fn) {
    checks.push({ name, fn });
}

check("lockfile-sync", () => {
    // After dropping the @taco-ai/sidecar-<platform> optionalDependencies
    // from packages/sidecar/package.json, the lockfile no longer tracks
    // them and `--frozen-lockfile` is the only check needed: if it
    // passes, lockfile and manifest agree.
    runPnpm(["install", "--frozen-lockfile"], { label: "lockfile-sync" });
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
check("desktop:build", () =>
    runPnpm(["--filter", "@taco-ai/desktop", "build"], { label: "desktop:build" }),
);
check("pack:smoke", () => runPnpm(["pack:smoke"], { label: "pack:smoke" }));
check("artifact-storage", () => {
    const usage = probeArtifactStorage();
    if (usage === null) {
        console.log(
            "  could not probe artifact storage (gh unavailable or no GH_REPO set) — skipping",
        );
        return;
    }
    const fmt = (b) => (b / 1024 / 1024 / 1024).toFixed(2);
    console.log(
        `  artifacts: ${fmt(usage.artifacts)}GB | cache: ${fmt(usage.cache)}GB | total: ${fmt(usage.total)}GB`,
    );
    // GitHub Free private repo: 500MB artifact + 2GB cache (combined model varies
    // by plan). Warn above 400MB total — releases often push 200-500MB of build
    // artifacts and we want a soft signal, not a hard error.
    if (usage.total > 400 * 1024 ** 2) {
        throw new Error(
            `artifact storage at ${fmt(usage.total)}GB; clean old artifacts before release ` +
                "(Settings → Actions → General → Artifact and log retention)",
        );
    }
    console.log("  under 400MB threshold — OK");
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

console.log("\n=== summary ===");
if (failed > 0) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
}
console.log("all checks passed — safe to push release tags");
