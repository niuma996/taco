/**
 * ESM dispatcher entry. The bin/taco.cjs shim spawns Node on this module
 * (the esbuild bundle dist/taco.mjs in the published package, or this
 * TypeScript source via tsx in a repo checkout) and lets it parse +
 * dispatch argv.
 *
 * Subcommands:
 *   start                — spawn sidecar daemon, print NDJSON socket path.
 *   status               — control.ping over the control socket.
 *   stop                 — control.shutdown over the control socket.
 *   install              — register the daemon with launchd / schtasks.
 *   uninstall            — reverse of install.
 *   upgrade              — fetch latest sidecar, stage it, write marker.
 *   upgrade --apply      — atomic swap of staged bundle into live install.
 *   connect              — debug stdio bridge (not implemented here).
 */

import { installCommand } from "./install.ts";
import { startCommand } from "./start.ts";
import { statusCommand } from "./status.ts";
import { stopCommand } from "./stop.ts";
import { uninstallCommand } from "./uninstall.ts";
import { upgradeCommand } from "./upgrade.ts";
import { upgradeApplyCommand } from "./upgradeApply.ts";

const usage = `taco — launcher + supervisor for the sidecar daemon

Usage:
  taco start                Spawn the daemon; prints its NDJSON socket path.
  taco status               Ping the daemon over the control socket.
  taco stop                 Ask the daemon to shut down gracefully.
  taco install              Register the daemon with launchd / schtasks.
  taco uninstall            Reverse of taco install; leaves wrapper in place.
  taco upgrade              Fetch latest sidecar, stage it, write upgrade marker.
  taco upgrade --apply      Atomic swap of staged bundle into the live install.
  taco help                 Show this message.

Environment:
  TACO_HOME                 Root directory for daemon state (default ~/.taco).
  TACO_SIDECAR_DEV=1        Force dev launcher (tsx + repo source) even when a
                            @taco-ai/sidecar-<platform> bundle is installed.
`;

export async function run(argv: readonly string[]): Promise<number> {
    const sub = argv[2];

    switch (sub) {
        case "start":
            await startCommand();
            return 0;
        case "status":
            await statusCommand();
            return 0;
        case "stop":
            await stopCommand();
            return 0;
        case "install":
            await installCommand();
            return 0;
        case "uninstall":
            await uninstallCommand();
            return 0;
        case "upgrade":
            if (argv.includes("--apply")) {
                await upgradeApplyCommand();
            } else {
                await upgradeCommand();
            }
            return 0;
        case "help":
        case "--help":
        case "-h":
        case undefined:
            process.stdout.write(usage);
            return 0;
        default:
            process.stderr.write(`unknown subcommand: ${sub}\n\n${usage}`);
            return 1;
    }
}

// Auto-run when invoked as the entry (node dist/taco.mjs, or tsx on the source).
const isEntry = (() => {
    try {
        const entry = process.argv[1];
        if (!entry) return false;
        const url = new URL(`file://${entry}`).href;
        return import.meta.url === url;
    } catch {
        return false;
    }
})();

if (isEntry) {
    run(process.argv).then(
        (code) => process.exit(code ?? 0),
        (err) => {
            process.stderr.write(`[taco] error: ${err?.stack ?? err}\n`);
            process.exit(1);
        },
    );
}
