/**
 * Hermetic TACO_HOME for one test file: points the env var at a fresh temp
 * dir and restores the previous value afterwards. Registers its own
 * before/after hooks — call once at module top level. `prefix` tags the
 * dir name so a leaked dir points back at its test file.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before } from "node:test";

export function useTempTacoHome(prefix?: string): string {
    const home = mkdtempSync(join(tmpdir(), `taco-home-${prefix ? `${prefix}-` : ""}`));
    let prev: string | undefined;
    before(() => {
        prev = process.env.TACO_HOME;
        process.env.TACO_HOME = home;
    });
    after(() => {
        if (prev === undefined) {
            Reflect.deleteProperty(process.env, "TACO_HOME");
        } else {
            process.env.TACO_HOME = prev;
        }
        rmSync(home, { recursive: true, force: true });
    });
    return home;
}
