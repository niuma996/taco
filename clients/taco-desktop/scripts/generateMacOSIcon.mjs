#!/usr/bin/env node
/**
 * generateMacOSIcon.mjs — build icon.icns for the macOS bundle.
 *
 * Two things matter for how macOS 26 (Tahoe) draws the installed icon:
 *
 * 1. The artwork must fill the canvas with opaque corners. Icons carrying
 *    transparent margins are drawn shrunken inside a gray rounded tray
 *    ("icon jail"). icon-macos-source.png is the full-bleed variant.
 * 2. The .icns must carry ic09/ic10/ic14 (512/1024) renditions. Tauri derives
 *    .icns from the PNGs in `bundle.icon`, whose largest is 256px, so its
 *    generated file stops at ic08/ic13 and macOS upscales from 256 in the Dock.
 *
 * Runs only on macOS; sips and iconutil ship with the OS.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const iconsDir = join(__dirname, "..", "src-tauri", "icons");
const sourceIcon = join(iconsDir, "icon-macos-source.png");
const outputIcns = join(iconsDir, "icon.icns");

// iconutil picks the .icns chunk for each file from its name. The 512x512@2x
// entry is what yields ic10 (1024px).
const renditions = [
    { px: 16, name: "16x16" },
    { px: 32, name: "16x16@2x" },
    { px: 32, name: "32x32" },
    { px: 64, name: "32x32@2x" },
    { px: 128, name: "128x128" },
    { px: 256, name: "128x128@2x" },
    { px: 256, name: "256x256" },
    { px: 512, name: "256x256@2x" },
    { px: 512, name: "512x512" },
    { px: 1024, name: "512x512@2x" },
];

function run(label, command, args) {
    const result = spawnSync(command, args, { stdio: "inherit" });
    if (result.status !== 0) {
        console.error(`[generateMacOSIcon] ${label} failed (status ${result.status})`);
        process.exit(result.status ?? 1);
    }
}

function main() {
    if (process.platform !== "darwin") {
        console.log("[generateMacOSIcon] Skipped: .icns generation requires macOS.");
        return;
    }

    if (!existsSync(sourceIcon)) {
        console.error(`[generateMacOSIcon] Source icon not found: ${sourceIcon}`);
        process.exit(1);
    }

    const workDir = mkdtempSync(join(tmpdir(), "taco-icon-"));
    const iconsetDir = join(workDir, "AppIcon.iconset");
    mkdirSync(iconsetDir);

    try {
        for (const { px, name } of renditions) {
            run("sips", "sips", [
                "-z",
                String(px),
                String(px),
                sourceIcon,
                "--out",
                join(iconsetDir, `icon_${name}.png`),
            ]);
        }

        run("iconutil", "iconutil", ["-c", "icns", iconsetDir, "-o", outputIcns]);
        console.log(`[generateMacOSIcon] Generated ${outputIcns}`);
    } finally {
        rmSync(workDir, { recursive: true, force: true });
    }
}

main();
