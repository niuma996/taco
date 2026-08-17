/**
 * Upgrade-marker read/write helpers. Marker lives at $TACO_HOME/upgrade-marker.json
 * (a constant already exposed by packages/cli/lib/paths.ts). The CLI
 * writes it; the daemon reads it on every boot.
 *
 * `readUpgradeMarker` is intentionally tolerant: a missing file (the
 * common case) returns null, and a malformed file logs + returns null
 * rather than throwing. The daemon's startup path can't fail because
 * of a bad marker — that would block every PR3 service-managed boot.
 *
 * `writeUpgradeMarker` is the CLI's counterpart (mirrors the cli package's
 * own marker writer so the on-disk shape is consistent regardless of
 * which side wrote it). Atomic via .tmp + rename.
 */

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createLogger } from "../lib/logger.ts";
import type { UpgradeMarker } from "./types.ts";

const log = createLogger("sidecar.upgrader.marker");

const JSON_INDENT = 2;

/** Read + parse the upgrade marker. Missing / malformed → null. */
export async function readUpgradeMarker(path: string): Promise<UpgradeMarker | null> {
    let raw: string;
    try {
        raw = await readFile(path, "utf8");
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        log.warn(`failed to read marker ${path}: ${String(err)}`);
        return null;
    }
    try {
        return JSON.parse(raw) as UpgradeMarker;
    } catch (err) {
        log.warn(`malformed marker ${path}: ${String(err)}`);
        return null;
    }
}

/** Persist a marker atomically. Creates the parent dir if missing. */
export async function writeUpgradeMarker(path: string, marker: UpgradeMarker): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(marker, null, JSON_INDENT), "utf8");
    await rename(tmp, path);
}

/** Delete a marker — used by `taco upgrade --apply` after the swap lands. */
export async function clearUpgradeMarker(path: string): Promise<void> {
    await unlink(path).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ENOENT") throw err;
    });
}
