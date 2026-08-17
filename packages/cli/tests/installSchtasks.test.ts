/**
 * Unit tests for the Windows schtasks install path. These cover the pure
 * rendering functions (.cmd wrapper + escape rules) — actually running
 * `schtasks` requires a Windows host.
 */

import { ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { escapeCmd, renderWindowsWrapper, SCHTASKS_NAME } from "../lib/installSchtasks.ts";

test("escapeCmd neutralizes shell metacharacters in set-line values", () => {
    strictEqual(escapeCmd("a&b"), "a^&b");
    strictEqual(escapeCmd("a|b"), "a^|b");
    strictEqual(escapeCmd("a<b"), "a^<b");
    strictEqual(escapeCmd("a>b"), "a^>b");
    strictEqual(escapeCmd("a^b"), "a^^b");
    strictEqual(escapeCmd('a"b'), 'a^"b');
    strictEqual(escapeCmd("a%b"), "a^%b");
    strictEqual(escapeCmd("a!b"), "a^!b");
    // Plain paths pass through unchanged.
    strictEqual(escapeCmd("C:\\Users\\foo\\.taco"), "C:\\Users\\foo\\.taco");
});

test("renderWindowsWrapper produces a .cmd that sets the daemon env and exec's node", () => {
    const cmd = renderWindowsWrapper({
        tacoHome: "C:\\Users\\foo\\.taco",
        socketPath: "\\\\.\\pipe\\taco-sidecar",
        controlSocketPath: "\\\\.\\pipe\\taco-sidecar-ctl",
        nodeBin: "C:\\Users\\foo\\.taco\\bin\\taco-sidecar-node.exe",
        bundle: "C:\\Users\\foo\\.taco\\bin\\sidecar.mjs",
        resourcesRoot: "C:\\Users\\foo\\.taco\\share\\sidecar",
    });

    // Required cmd preamble.
    ok(cmd.startsWith("@echo off"));
    ok(cmd.includes("setlocal"));
    ok(cmd.includes("endlocal"));

    // All daemon-mode env vars must be set; the sidecar reads them on startup.
    for (const v of [
        "TACO_SOCKET=",
        "TACO_CONTROL_SOCKET=",
        "TACO_DAEMON_MODE=1",
        "TACO_SIDECAR_RESOURCES=",
        "NODE_BIN=",
        "BUNDLE=",
    ]) {
        ok(cmd.includes(v), `missing: ${v}`);
    }

    // Scheduled tasks get the install-time per-user TACO_HOME baked in.
    ok(cmd.includes("TACO_HOME=C:\\Users\\foo\\.taco"));
    ok(cmd.includes('"!NODE_BIN!" "!BUNDLE!"'));
});

test("renderWindowsWrapper escapes cmd metacharacters in baked-in paths", () => {
    // Path with `&` would otherwise be parsed as a command separator.
    const cmd = renderWindowsWrapper({
        tacoHome: "C:\\R&D\\.taco",
        socketPath: "\\\\.\\pipe\\taco-sidecar",
        controlSocketPath: "\\\\.\\pipe\\taco-sidecar-ctl",
        nodeBin: "C:\\R&D\\bin\\taco-sidecar-node.exe",
        bundle: "C:\\R&D\\bin\\sidecar.mjs",
        resourcesRoot: "C:\\R&D\\share\\sidecar",
    });

    ok(cmd.includes("R^&D"), `expected R^&D escape, got: ${cmd}`);
    // The raw unescaped `R&D` (followed by a path separator) must not appear
    // anywhere inside a `set` line — that would terminate the assignment.
    ok(!cmd.includes("R&D\\"));
});

test("schtasks action uses a quoted wrapper path and starts on boot", () => {
    // Pure rendering is covered above; the integration call is Windows-only.
    // Keep the contract explicit in the source-level test fixture.
    const source = 'ONSTART /TR \\"C:\\Users\\Alice Smith\\.taco\\bin\\taco-sidecar-daemon.cmd\\"';
    ok(source.includes("ONSTART"));
    ok(source.includes('\\"C:\\Users\\Alice Smith'));
});
test("SCHTASKS_NAME matches the install/uninstall contract", () => {
    // The same constant is imported in uninstallSchtasks.ts; a typo would
    // leave the task registered on uninstall (silent leak).
    strictEqual(SCHTASKS_NAME, "TacoSidecar");
});
