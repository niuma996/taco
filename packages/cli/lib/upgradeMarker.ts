/**
 * CLI-side upgrade-marker helpers.
 *
 * Mirrors the on-disk shape that the sidecar's `upgrader/marker.ts` reads.
 * We intentionally duplicate the tiny read/write/clear surface here rather
 * than importing from `@taco-ai/sidecar` — the CLI doesn't depend on the
 * sidecar's TS source (the bundled platform pkg is what ships at runtime),
 * and the public exports of `@taco-ai/sidecar` are the runtime entry, not
 * the marker module. The duplication is bounded: the type + 3 functions,
 * covered by `upgradeMarker.test.ts` so on-disk drift surfaces immediately.
 *
 * Tolerant read: a missing file (the common case after `upgrade --apply`)
 * returns null; a malformed file logs + returns null rather than throwing,
 * so the operator-visible error stays with whoever wrote the bad marker.
 */

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createLogger } from "./upgradeLogger.ts";
import type { UpgradeMarker } from "./upgradeTypes.ts";

const log = createLogger("taco.cli.upgrade.marker");

const JSON_INDENT = 2;

export async function readUpgradeMarker(filePath: string): Promise<UpgradeMarker | null> {
    let raw: string;
    try {
        raw = await readFile(filePath, "utf8");
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        log.warn(`failed to read marker ${filePath}: ${String(err)}`);
        return null;
    }
    try {
        return JSON.parse(raw) as UpgradeMarker;
    } catch (err) {
        log.warn(`malformed marker ${filePath}: ${String(err)}`);
        return null;
    }
}

export async function writeUpgradeMarker(filePath: string, marker: UpgradeMarker): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(marker, null, JSON_INDENT), "utf8");
    await rename(tmp, filePath);
}

export async function clearUpgradeMarker(filePath: string): Promise<void> {
    await unlink(filePath).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ENOENT") throw err;
    });
}
