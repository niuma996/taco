#!/usr/bin/env tsx
/** Minimal CLI debug client for exercising the sidecar protocol. */

import { resolve as resolvePath } from "node:path";
import * as readline from "node:readline";
import { TacoClient } from "@taco-ai/shared/node";
import { createDefaultSidecarSpawn } from "@taco-ai/shared/spawn";

async function createClient(opts: { autoStart?: boolean } = {}): Promise<TacoClient> {
    const client = new TacoClient(createDefaultSidecarSpawn());
    if (opts.autoStart !== false) {
        await client.start();
        client.onPush((p) => {
            // Write pushes to stderr to avoid interfering with stdin echo.
            process.stderr.write(
                `[push] ${p.method} ws=${p.workspace} session=${p.session ?? "-"}\n`,
            );
            if (p.params && typeof p.params === "object") {
                process.stderr.write(`      ${JSON.stringify(p.params).slice(0, 200)}\n`);
            }
        });
    }
    return client;
}

function usage() {
    process.stderr.write(`Taco CLI debug client

Usage:
  start                                       # spawn sidecar + REPL
  workspaces                                  # list active workspaces
  send <cwd> <text>                           # session.create + prompt in cwd
  history <cwd> <sessionId>                   # pull history
  watch <cwd>                                 # subscribe to pushes only
`);
}

async function cmdStart() {
    const client = await createClient();
    await client.handshake();
    process.stderr.write(
        "[taco] sidecar ready, type commands: /list, /send <text>, /cd <cwd>, /checkpoints, /restore <id>, /quit\n",
    );

    let currentCwd = process.cwd();
    let currentSession: string | null = null;

    // Wrap stdin so `/restore` can prompt for confirmation on the same line
    // editor the REPL already uses. Anything that is not clearly yes or no is
    // re-asked rather than silently treated as "no": a mistyped confirmation
    // should not look identical to a deliberate abort. Resolves null when the
    // stream closes (Ctrl-D), which the caller treats as abort.
    const rl = readline.createInterface({ input: process.stdin });
    const ask = (question: string): Promise<string | null> =>
        new Promise((resolve) => {
            const onClose = () => resolve(null);
            rl.once("close", onClose);
            rl.question(question, (answer) => {
                rl.off("close", onClose);
                resolve(answer);
            });
        });
    const confirm = async (question: string): Promise<boolean | null> => {
        for (;;) {
            const answer = await ask(question);
            if (answer === null) return null;
            const a = answer.trim().toLowerCase();
            if (a === "yes" || a === "y") return true;
            if (a === "no" || a === "n") return false;
            process.stderr.write("[taco] please answer yes or no\n");
        }
    };

    for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed === "/quit" || trimmed === "/exit") break;

        if (trimmed === "/list") {
            const list = await client.sessionList(currentCwd);
            process.stderr.write(`${JSON.stringify(list, null, 2)}\n`);
            continue;
        }

        if (trimmed === "/checkpoints") {
            const r = await client.checkpointsList(currentCwd);
            if (!r.enabled) {
                process.stderr.write("[taco] checkpoints are disabled for this workspace\n");
                continue;
            }
            if (r.checkpoints.length === 0) {
                process.stderr.write("[taco] no checkpoints yet\n");
                continue;
            }
            for (const c of r.checkpoints) {
                const paths = c.files
                    .map((f) => `${f.path}${f.existed ? "" : " (new)"}`)
                    .join(", ");
                process.stderr.write(`  ${c.id}  ${c.createdAt}  ${c.label}\n    ${paths}\n`);
            }
            continue;
        }

        if (trimmed.startsWith("/restore ")) {
            const id = trimmed.slice(9).trim();
            const list = await client.checkpointsList(currentCwd);
            const cp = list.enabled ? list.checkpoints.find((c) => c.id === id) : undefined;
            if (!cp) {
                process.stderr.write(`[taco] checkpoint not found: ${id}\n`);
                continue;
            }
            process.stderr.write(`[taco] about to restore ${cp.label} (${cp.createdAt})\n`);
            for (const f of cp.files) {
                const action = f.existed ? "rewrite" : "delete ";
                process.stderr.write(`  ${action}  ${f.path}\n`);
            }
            const yes = await confirm("Restore these files? [yes/no] ");
            if (yes !== true) {
                process.stderr.write("[taco] aborted\n");
                if (yes === null) break;
                continue;
            }
            const r = await client.checkpointsRestore(currentCwd, id, currentSession ?? undefined);
            for (const p of r.restored) process.stderr.write(`  restored ${p}\n`);
            for (const p of r.deleted) process.stderr.write(`  deleted  ${p}\n`);
            for (const f of r.failed) process.stderr.write(`  FAILED   ${f.path}: ${f.reason}\n`);
            if (r.protectionId) {
                process.stderr.write(`[taco] pre-restore checkpoint: ${r.protectionId}\n`);
            }
            continue;
        }

        if (trimmed.startsWith("/cd ")) {
            currentCwd = resolvePath(trimmed.slice(4));
            process.stderr.write(`[taco] cwd -> ${currentCwd}\n`);
            currentSession = null;
            continue;
        }

        if (trimmed.startsWith("/send ")) {
            const text = trimmed.slice(6);
            const r = await client.sessionCreate({
                workspace: currentCwd,
                initialPrompt: text,
            });
            currentSession = r.sessionId;
            process.stderr.write(`[taco] session=${currentSession}\n`);
            process.stderr.write(`${JSON.stringify(r.assistantMessage, null, 2)}\n`);
            continue;
        }

        // Prompt the active session by default.
        if (!currentSession) {
            // Open a session if none is active.
            const r = await client.sessionCreate({
                workspace: currentCwd,
                initialPrompt: trimmed,
            });
            currentSession = r.sessionId;
            process.stderr.write(`[taco] new session=${currentSession}\n`);
            process.stderr.write(`${JSON.stringify(r.assistantMessage, null, 2)}\n`);
        } else {
            const r = await client.sessionPrompt(currentCwd, currentSession, trimmed);
            process.stderr.write(`${JSON.stringify(r.assistantMessage, null, 2)}\n`);
        }
    }

    await client.dispose();
}

async function cmdSend(cwd: string, text: string) {
    const client = await createClient();
    await client.handshake();
    const r = await client.sessionCreate({
        workspace: resolvePath(cwd),
        initialPrompt: text,
    });
    console.log(JSON.stringify(r, null, 2));
    await client.dispose();
}

async function cmdHistory(cwd: string, sessionId: string) {
    const client = await createClient();
    await client.handshake();
    const r = await client.sessionHistory(resolvePath(cwd), sessionId);
    console.log(JSON.stringify(r, null, 2));
    await client.dispose();
}

async function cmdWatch(cwd: string) {
    const client = await createClient();
    await client.handshake();
    // Ensure the workspace on the server.
    await client.workspaceEnsure(resolvePath(cwd));
    process.stderr.write(`[taco] watching ${cwd} (ctrl-c to exit)\n`);
    await new Promise(() => {});
}

async function main() {
    // Tolerate `pnpm start -- send ...` (pnpm forwards the `--`).
    const argv = process.argv.slice(2)[0] === "--" ? process.argv.slice(3) : process.argv.slice(2);
    const cmd = argv[0] ?? "start";
    switch (cmd) {
        case "start":
            await cmdStart();
            break;
        case "send":
            if (argv.length < 3) {
                usage();
                process.exit(1);
            }
            await cmdSend(argv[1], argv[2]);
            break;
        case "history":
            if (argv.length < 3) {
                usage();
                process.exit(1);
            }
            await cmdHistory(argv[1], argv[2]);
            break;
        case "watch":
            if (argv.length < 2) {
                usage();
                process.exit(1);
            }
            await cmdWatch(argv[1]);
            break;
        default:
            usage();
            process.exit(1);
    }
}

main().catch((err) => {
    process.stderr.write(`fatal: ${err?.stack ?? err}\n`);
    process.exit(1);
});
