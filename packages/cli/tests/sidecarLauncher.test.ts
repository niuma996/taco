import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { locateTsxLoader, resolveDevLaunch } from "../lib/sidecarLauncher.ts";

const scratch = mkdtempSync(join(tmpdir(), "taco-sidecar-launcher-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

test("resolveDevLaunch spawns node --import tsx/dist/loader.mjs, never the CLI or .bin shim", () => {
    const tsxDir = join(scratch, "node_modules", "tsx", "dist");
    mkdirSync(tsxDir, { recursive: true });
    writeFileSync(join(tsxDir, "loader.mjs"), "export {};\n");
    mkdirSync(join(scratch, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(scratch, "node_modules", ".bin", "tsx.cmd"), "@echo off\n");
    writeFileSync(join(tsxDir, "cli.mjs"), "export {};\n");

    const launch = resolveDevLaunch(scratch);
    assert.equal(launch.program, process.execPath);
    assert.equal(launch.args[0], "--import");
    assert.equal(launch.args[1], pathToFileURL(join(tsxDir, "loader.mjs")).href);
    assert.equal(launch.args[2], join(scratch, "packages", "sidecar", "src", "index.ts"));
    assert.equal(launch.cwd, scratch);
    assert.ok(!launch.args.some((a) => a.endsWith(".cmd")), "must not spawn the Windows .cmd shim");
    assert.ok(
        !launch.args.some((a) => a.includes("cli.mjs")),
        "must not spawn tsx/dist/cli.mjs (it re-forks node without windowsHide)",
    );
});

test("locateTsxLoader prefers the checkout-local tsx over a nested walk", () => {
    const tsxDir = join(scratch, "node_modules", "tsx", "dist");
    mkdirSync(tsxDir, { recursive: true });
    writeFileSync(join(tsxDir, "loader.mjs"), "export {};\n");
    assert.equal(locateTsxLoader(scratch), join(tsxDir, "loader.mjs"));
});
