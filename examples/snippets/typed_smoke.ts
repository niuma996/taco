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
 * The sidecar runs against a throwaway $TACO_HOME: without it the smoke
 * run would read the real ~/.taco (IM channel credentials — the sidecar
 * would connect to the user's live channels) and write into the real
 * session store.
 *
 * Import paths: this script lives in `examples/snippets/` and pulls the
 * workspace copies of `@taco-ai/shared` and `@taco-ai/protocol` from
 * `../../packages/{shared,protocol}/dist/`. The example app
 * (`examples/node-tui`) is *not* a workspace member — the full TUI uses
 * `pnpm add @taco-ai/{protocol,shared}@^0.2.10` against npm instead.
 *
 * Usage (from repo root, against a monorepo checkout):
 *   pnpm protocol:build && pnpm shared:build
 *   pnpm exec tsx examples/snippets/typed_smoke.ts [cwd]
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asWorkspaceId } from "../../packages/protocol/dist/index.js";
import { createDefaultSidecarSpawn } from "../../packages/shared/dist/spawn.js";
import { TacoClient } from "../../packages/shared/dist/tacoClientNode.js";

async function main(): Promise<number> {
    const cwd = process.argv[2] ?? process.cwd();
    const cmd = process.env.TACO_SIDECAR_CMD ?? "taco-sidecar";
    const args = process.env.TACO_SIDECAR_ARGS ? process.env.TACO_SIDECAR_ARGS.split(" ") : [];

    const home = mkdtempSync(join(tmpdir(), "taco-smoke-home-"));
    console.log(`[typed_smoke] TACO_HOME: ${home}`);

    const client = new TacoClient(
        createDefaultSidecarSpawn({
            command: cmd,
            args,
            env: {
                TACO_HOME: home,
                // TACO_SESSIONS_ROOT wins over the TACO_HOME-derived path, so
                // pin it too — a user-set value would otherwise write into
                // the real store.
                TACO_SESSIONS_ROOT: join(home, "sessions"),
            },
        }),
    );
    try {
        await client.start();
        // The typed client sends its own protocol version; only the
        // capability declaration is passed in.
        const handshake = await client.handshake();
        console.log(
            `[typed_smoke] initialize: server=${handshake.serverVersion} ` +
                `protocol=${handshake.protocolVersion.major}.${handshake.protocolVersion.minor} ` +
                `pid=${handshake.pid ?? "?"} instance=${(handshake.instanceId ?? "").slice(0, 8)}`,
        );

        const workspaces = await client.workspaceList();
        console.log(`[typed_smoke] workspace.list: ${JSON.stringify(workspaces)}`);

        await client.workspaceEnsure(asWorkspaceId(cwd));
        console.log(`[typed_smoke] workspace.ensure: cwd=${cwd}`);

        const sessions = await client.sessionList(asWorkspaceId(cwd));
        const list = sessions?.sessions ?? [];
        console.log(`[typed_smoke] session.list: ${list.length} session(s)`);

        return 0;
    } finally {
        await client.dispose();
        rmSync(home, { recursive: true, force: true });
    }
}

main().then(
    (code) => process.exit(code),
    (err) => {
        console.error("[typed_smoke] failed:", err);
        process.exit(1);
    },
);
