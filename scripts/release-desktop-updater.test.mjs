import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(".github/workflows/release-desktop.yml", "utf8");

test("macOS release stages a gzip updater archive separate from the DMG", () => {
    assert.match(workflow, /tar -C .*bundle\/macos -czf "\$\{ARTIFACT\}\.app\.tar\.gz" Taco\.app/);
    assert.match(workflow, /name\.endswith\('\.app\.tar\.gz'\)/);
    assert.match(workflow, /\.app\.tar\.gz\.minisig/);
    assert.doesNotMatch(workflow, /if name\.endswith\('\.dmg'\)/);
});
