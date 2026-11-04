import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("./index.mjs", import.meta.url));

test("explicit runtime must exist; never silently rebuild or skip", () => {
    const dir = mkdtempSync(join(tmpdir(), "taco-regression-test-"));
    try {
        const result = spawnSync(process.execPath, [runner, "--runtime", dir], {
            encoding: "utf8",
            timeout: 5_000,
        });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /\[FAIL\] runtime files:.*manifest.json/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("unknown arguments fail rather than running a different suite", () => {
    const result = spawnSync(process.execPath, [runner, "--full"], {
        encoding: "utf8",
        timeout: 5_000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown argument: --full/);
});
