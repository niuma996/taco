/**
 * typed_smoke.ts — minimal NDJSON stdio smoke test for taco-sidecar
 * using the @taco-ai/{protocol,shared} typed client.
 *
 * Drives the same protocol surface as stdio_smoke.py without touching
 * LLM state: initialize → workspaceList → workspaceEnsure → sessionList
 * → dispose.
 *
 * Sidecar resolution follows the same rules as the full client:
 *   - $TACO_SIDECAR_CMD (split on whitespace) overrides PATH lookup
 *   - falls back to `taco-sidecar` on PATH
 *
 * Import paths: this script lives in `examples/snippets/` and pulls the
 * workspace copies of `@taco-ai/shared` and `@taco-ai/protocol` from
 * `../../packages/{shared,protocol}/dist/`. The example app
 * (`examples/node-tui`) is *not* a workspace member — the full TUI uses
 * `pnpm add @taco-ai/{protocol,shared}@^0.2.0` against npm instead.
 *
 * Usage (from repo root, against a monorepo checkout):
 *   pnpm exec tsx examples/snippets/typed_smoke.ts [cwd]
 */

import { createDefaultSidecarSpawn } from "../../packages/shared/dist/spawn.js";
import { TacoClient } from "../../packages/shared/dist/tacoClientNode.js";

async function main(): Promise<number> {
    const cwd = process.argv[2] ?? process.cwd();
    const cmd = process.env.TACO_SIDECAR_CMD ?? "taco-sidecar";
    const args = process.env.TACO_SIDECAR_ARGS ? process.env.TACO_SIDECAR_ARGS.split(" ") : [];

    const client = new TacoClient(createDefaultSidecarSpawn({ command: cmd, args }));
    try {
        await client.start();
        const handshake = await client.handshake({
            protocolVersion: { major: 2, minor: 0 },
            clientCapabilities: {},
        });
        console.log(
            `[typed_smoke] initialize: server=${handshake.serverVersion} ` +
                `protocol=${handshake.protocolVersion.major}.${handshake.protocolVersion.minor} ` +
                `pid=${handshake.pid ?? "?"} instance=${(handshake.instanceId ?? "").slice(0, 8)}`,
        );

        const workspaces = await client.workspaceList();
        console.log(`[typed_smoke] workspace.list: ${JSON.stringify(workspaces)}`);

        await client.workspaceEnsure(cwd);
        console.log(`[typed_smoke] workspace.ensure: cwd=${cwd}`);

        const sessions = await client.sessionList(cwd);
        const list = sessions?.sessions ?? [];
        console.log(`[typed_smoke] session.list: ${list.length} session(s)`);

        return 0;
    } finally {
        await client.dispose();
    }
}

main().then(
    (code) => process.exit(code),
    (err) => {
        console.error("[typed_smoke] failed:", err);
        process.exit(1);
    },
);
