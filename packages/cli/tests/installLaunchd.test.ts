/**
 * Unit tests for the macOS launchd install path. These cover the pure
 * rendering functions (plist + wrapper script) — actually running
 * `launchctl load` requires a real macOS host.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import {
    escapeXml,
    LAUNCHD_LABEL,
    renderLaunchdPlist,
    renderPosixWrapper,
} from "../lib/installLaunchd.ts";

test("escapeXml escapes ampersands, angle brackets, and quotes", () => {
    strictEqual(escapeXml("a&b"), "a&amp;b");
    strictEqual(escapeXml("<x>"), "&lt;x&gt;");
    strictEqual(escapeXml(`he said "hi"`), "he said &quot;hi&quot;");
    strictEqual(escapeXml("it's"), "it&apos;s");
});

test("renderLaunchdPlist produces well-formed XML with all required keys", () => {
    const xml = renderLaunchdPlist({
        wrapperPath: "/Users/u/.taco/bin/taco-sidecar-daemon",
        tacoHome: "/Users/u/.taco",
        logDir: "/Users/u/.taco/logs",
    });

    // Must include a DOCTYPE + plist version so launchd parses it as XML.
    ok(xml.includes('<?xml version="1.0" encoding="UTF-8"?>'));
    ok(xml.includes("<!DOCTYPE plist"));
    ok(xml.includes('<plist version="1.0">'));

    // Required keys for a KeepAlive service that restarts on crash.
    for (const key of [
        "<key>Label</key>",
        "<key>ProgramArguments</key>",
        "<key>RunAtLoad</key>",
        "<key>KeepAlive</key>",
        "<key>ThrottleInterval</key>",
        "<key>StandardOutPath</key>",
        "<key>StandardErrorPath</key>",
    ]) {
        ok(xml.includes(key), `missing key: ${key}`);
    }

    // Label must match the launchd agent filename.
    ok(xml.includes(`<string>${LAUNCHD_LABEL}</string>`));
    // Wrapper path is the only ProgramArguments entry (single-element array).
    ok(xml.includes("<string>/Users/u/.taco/bin/taco-sidecar-daemon</string>"));
    // TACO_HOME propagates so the wrapper doesn't have to walk to find itself.
    ok(xml.includes("<key>TACO_HOME</key>"));
    ok(xml.includes("<string>/Users/u/.taco</string>"));
});

test("renderLaunchdPlist escapes XML metacharacters in paths", () => {
    const xml = renderLaunchdPlist({
        wrapperPath: "/Users/u/R&D/bin/taco-sidecar-daemon",
        tacoHome: "/Users/u/R&D",
        logDir: "/Users/u/R&D/logs",
    });

    // `&` must escape to `&amp;`; without it the plist parser treats `R&D`
    // as an undefined entity reference and rejects the file.
    ok(xml.includes("R&amp;D"));
    ok(!xml.includes("R&D/bin"));
});

test("renderPosixWrapper produces a runnable shell script that sets env + exec's node", () => {
    const script = renderPosixWrapper({
        socketPath: "/Users/u/.taco/run/sidecar.sock",
        controlSocketPath: "/Users/u/.taco/run/sidecar-ctl.sock",
        nodeBin: "/Users/u/.taco/bin/taco-sidecar-node",
        bundle: "/Users/u/.taco/bin/sidecar.mjs",
        resourcesRoot: "/Users/u/.taco/share/sidecar",
    });

    // POSIX shebang + set -e so a failure bubbles up to launchd.
    ok(script.startsWith("#!/bin/sh\n"));
    ok(script.includes("set -e"));

    // The wrapper must export the daemon-mode env the sidecar reads on startup.
    for (const line of [
        "export TACO_DAEMON_MODE=1",
        "export TACO_HOME",
        "export TACO_SOCKET=",
        "export TACO_CONTROL_SOCKET=",
        "export TACO_SIDECAR_RESOURCES=",
    ]) {
        ok(script.includes(line), `missing line: ${line}`);
    }

    // Final exec: invoke the bundled node with the sidecar entry.
    ok(script.includes('exec "$NODE_BIN" "$BUNDLE"'));

    // TACO_HOME is computed relative to the wrapper's location so launchd's
    // plist doesn't need an absolute path baked in (the wrapper finds itself).
    ok(script.includes('cd -- "$(dirname -- "$0")"'));
});

test("renderPosixWrapper shell-quotes paths without XML escaping", () => {
    const script = renderPosixWrapper({
        socketPath: "/Users/u/R&D/taco's home/run/sidecar.sock",
        controlSocketPath: "/Users/u/R&D/taco's home/run/sidecar-ctl.sock",
        nodeBin: "/Users/u/R&D/taco's home/bin/node",
        bundle: "/Users/u/R&D/taco's home/lib/index.mjs",
        resourcesRoot: "/Users/u/R&D/taco's home/share",
    });

    ok(script.includes("R&D"));
    ok(!script.includes("&amp;"));
    ok(script.includes("taco'\\''s home"));
});

test("renderPosixWrapper bakes the platform pkg paths so they survive pnpm update", () => {
    const script = renderPosixWrapper({
        socketPath: "/Users/u/.taco/run/sidecar.sock",
        controlSocketPath: "/Users/u/.taco/run/sidecar-ctl.sock",
        nodeBin: "/Users/u/.taco/bin/taco-sidecar-node",
        bundle: "/Users/u/.taco/bin/sidecar.mjs",
        resourcesRoot: "/Users/u/.taco/share/sidecar",
    });

    deepStrictEqual(
        [
            "/Users/u/.taco/bin/taco-sidecar-node",
            "/Users/u/.taco/bin/sidecar.mjs",
            "/Users/u/.taco/share/sidecar",
        ].every((p) => script.includes(p)),
        true,
    );
});
