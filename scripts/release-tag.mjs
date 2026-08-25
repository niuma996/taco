#!/usr/bin/env node
/**
 * release-tag.mjs — move desktop-v* and sidecar-v* tags to HEAD and push.
 *
 * Tags are force-moved (delete remote + recreate locally + push) because
 * the release pipeline overwrites the version at publish time and the
 * `git checkout --` reset in the workflow only restores manifests — it
 * does not move the tag back if the publish job crashed mid-way.
 *
 * Defaults to dry-run; pass `--push` to actually delete-and-push tags.
 * Always refuses to run with a dirty working tree unless `--allow-dirty`
 * is passed (the tag should point at a clean release commit).
 *
 * Usage:
 *   node scripts/release-tag.mjs 0.1.1              # dry-run, just print plan
 *   node scripts/release-tag.mjs 0.1.1 --push       # force-move + push
 *   node scripts/release-tag.mjs 0.1.1 --allow-dirty
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

const args = process.argv.slice(2);
const version = args.find((a) => /^\d+\.\d+\.\d+/.test(a));
const doPush = args.includes("--push");
const allowDirty = args.includes("--allow-dirty");

if (!version) {
    console.error("usage: release-tag.mjs <version> [--push] [--allow-dirty]");
    process.exit(2);
}

const git = process.env.GIT ?? "git";

/** Run git, return {stdout, stderr, status}. Throws only if git itself is missing. */
function gitRun(...gitArgs) {
    const result = spawnSync(git, gitArgs, {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: process.env,
    });
    if (result.error) throw result.error;
    return result;
}

function isWorkingTreeClean() {
    const r = gitRun("status", "--porcelain");
    return r.status === 0 && r.stdout.trim().length === 0;
}

function currentHead() {
    return gitRun("rev-parse", "HEAD").stdout.trim();
}

function localTagExists(name) {
    return existsSync(resolve(REPO_ROOT, ".git/refs/tags", name));
}

function remoteTagSha(name) {
    const r = gitRun("ls-remote", "origin", `refs/tags/${name}`);
    if (r.status !== 0 || !r.stdout.trim()) return null;
    const match = r.stdout.match(/^([0-9a-f]+)\s+/);
    return match ? match[1] : null;
}

const tags = [`desktop-v${version}`, `sidecar-v${version}`];

console.log(`target tags: ${tags.join(", ")}`);
console.log(`mode:        ${doPush ? "PUSH" : "dry-run"}`);

if (!isWorkingTreeClean()) {
    if (allowDirty) {
        console.warn("warning: working tree is dirty (--allow-dirty)");
    } else {
        console.error("error: working tree is dirty — commit, stash, or pass --allow-dirty");
        process.exit(1);
    }
}

const head = currentHead();
console.log(`HEAD:        ${head.slice(0, 12)}`);

for (const tag of tags) {
    const localExists = localTagExists(tag);
    const remoteSha = remoteTagSha(tag);
    if (remoteSha && remoteSha !== head) {
        console.log(`  ${tag}: remote=${remoteSha.slice(0, 12)} → ${head.slice(0, 12)} (move)`);
    } else if (localExists) {
        console.log(`  ${tag}: local exists at ${head.slice(0, 12)} (idempotent)`);
    } else {
        console.log(`  ${tag}: new tag at ${head.slice(0, 12)}`);
    }
}

if (!doPush) {
    console.log("\n(dry-run; pass --push to force-move + push)");
    process.exit(0);
}

for (const tag of tags) {
    gitRun("tag", "-f", tag, head);
    console.log(`local:      ${tag} → ${head.slice(0, 12)}`);
}

const remoteShaBefore = remoteTagSha(tags[0]);
if (remoteShaBefore) {
    console.log(`\ndeleting remote ${tags[0]} ${remoteShaBefore.slice(0, 12)}`);
    gitRun("push", "origin", `:refs/tags/${tags[0]}`);
}
const remoteShaBefore2 = remoteTagSha(tags[1]);
if (remoteShaBefore2) {
    console.log(`deleting remote ${tags[1]} ${remoteShaBefore2.slice(0, 12)}`);
    gitRun("push", "origin", `:refs/tags/${tags[1]}`);
}

console.log(`\npushing ${tags.join(", ")} → ${head.slice(0, 12)}`);
const pushResult = gitRun("push", "origin", ...tags);
process.stdout.write(pushResult.stdout);
process.stderr.write(pushResult.stderr);
process.exit(pushResult.status ?? 1);
