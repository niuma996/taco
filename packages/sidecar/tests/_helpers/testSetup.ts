/**
 * Process-wide test isolation, preloaded before every test file via
 * `node --import`.
 *
 * Several modules resolve `tacoHome()` while they are imported (memory store,
 * IM workspace policies, upgrade marker). A `before()` hook runs after those
 * imports, so per-file helpers like useTempTacoHome() cannot protect the
 * import-time path. This module runs first and points TACO_HOME at a fresh
 * temp dir, keeping test runs out of the developer's real ~/.taco.
 *
 * Files that need a different home still override TACO_HOME themselves.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "taco-test-home-"));
process.env.TACO_HOME = home;

process.on("exit", () => {
    rmSync(home, { recursive: true, force: true });
});
