/**
 * Runs the full prompt/streaming path and asserts key events.
 * Skips with exit code 0 when no API credentials are available.
 * With credentials, it starts the sidecar, creates a session, and verifies
 * the message lifecycle, agent completion, PONG response, and no errors.
 */

import { mkdirSync, rmSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerPush } from "@taco-ai/protocol";
import { TacoClient } from "@taco-ai/shared/node";
import { createDefaultSidecarSpawn } from "@taco-ai/shared/spawn";

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolvePath(__filename, "..");

// ── assertion helpers ───────────────────────────────────────────────

let failed = 0;
function check(label: string, cond: boolean, detail?: string): void {
    if (cond) {
        process.stderr.write(`  ✓ ${label}\n`);
    } else {
        failed++;
        process.stderr.write(`  ✗ ${label}${detail ? `: ${detail}` : ""}\n`);
    }
}

function extractText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .map((c) => {
                if (c && typeof c === "object" && "text" in c)
                    return String((c as { text?: unknown }).text ?? "");
                return "";
            })
            .join("");
    }
    return "";
}

// ── main ────────────────────────────────────────────────────────────

async function main(): Promise<number> {
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_OAUTH_TOKEN) {
        process.stderr.write("[e2e] no ANTHROPIC_API_KEY / ANTHROPIC_OAUTH_TOKEN — skip\n");
        return 0;
    }

    const repoRoot = resolvePath(__dirname, "../../..");
    // Use a fresh directory so session history cannot affect event-count assertions.
    const sandboxRoot = `/tmp/taco-e2e-${Date.now()}`;
    const cwd = `${sandboxRoot}/workspace`;
    mkdirSync(cwd, { recursive: true });

    const client = new TacoClient(
        createDefaultSidecarSpawn({
            repoRoot,
            env: {
                TACO_SESSIONS_ROOT: `${sandboxRoot}/sessions`,
                TACO_DEFAULT_MODEL: process.env.TACO_DEFAULT_MODEL ?? "claude-sonnet-4-5",
            },
        }),
    );

    // Collect pushes for assertions.
    const pushEvents: ServerPush[] = [];
    const sessionEventTypes: string[] = [];
    let sessionErrorCount = 0;
    let assistantText = "";
    /** Resolves on agent_end to signal that the turn has fully settled. */
    let agentEndResolve: (() => void) | null = null;
    const agentEndPromise = new Promise<void>((resolve) => {
        agentEndResolve = resolve;
    });

    client.onPush((p) => {
        pushEvents.push(p);
        if (p.method === "session.event") {
            const ev = (
                p.params as
                    | { event?: { type?: string; message?: { role?: string; content?: unknown } } }
                    | undefined
            )?.event;
            if (ev?.type) sessionEventTypes.push(ev.type);
            // Stream incremental + terminal-merge deltas.
            if (ev?.type === "message_update" && ev.message?.role === "assistant") {
                assistantText += extractText(ev.message.content);
            } else if (ev?.type === "message_end" && ev.message?.role === "assistant") {
                const t = extractText(ev.message.content);
                if (t && !assistantText.endsWith(t)) assistantText += t;
            } else if (ev?.type === "agent_end") {
                agentEndResolve?.();
            }
        } else if (p.method === "session.error") {
            sessionErrorCount++;
            process.stderr.write(`  [session.error] ${JSON.stringify(p.params)}\n`);
        }
    });
    client.on("warn", (w: unknown) => process.stderr.write(`[warn] ${JSON.stringify(w)}\n`));
    client.on("stderr", (s: string) => process.stderr.write(`[sidecar] ${s}`));

    try {
        await client.start();
        await client.waitForReady();
        process.stderr.write("[e2e] sidecar ready (hello + initialize)\n");

        await client.workspaceEnsure(cwd);
        process.stderr.write(`[e2e] workspace ensured (${cwd})\n`);

        // Force the model to reply "PONG" so the assertion stays stable.
        const prompt =
            "Reply with exactly the word 'PONG' and nothing else. Do not add punctuation, explanation, or markdown.";
        process.stderr.write("[e2e] sending prompt\n");
        const r = await client.sessionCreate({ workspace: cwd, initialPrompt: prompt });
        process.stderr.write(`[e2e] session.create -> ${r.sessionId}\n`);

        // session.create waits synchronously for the reply; after agent_end, give a
        // 100ms buffer so any trailing pushes settle (instead of a fixed 200ms sleep).
        await agentEndPromise;
        await new Promise((r) => setTimeout(r, 100));

        process.stderr.write("\n[e2e] assertions:\n");
        check(
            "sidecar.hello received",
            pushEvents.some((p) => p.method === "sidecar.hello"),
        );
        check(
            "session.attached received",
            pushEvents.some((p) => p.method === "session.attached"),
        );
        check(
            "message_start received",
            sessionEventTypes.includes("message_start"),
            `types=[${sessionEventTypes.join(",")}]`,
        );
        check(
            "message_update received (streaming chunk)",
            sessionEventTypes.includes("message_update"),
            `types=[${sessionEventTypes.join(",")}]`,
        );
        check(
            "message_end received",
            sessionEventTypes.includes("message_end"),
            `types=[${sessionEventTypes.join(",")}]`,
        );
        check(
            "agent_end received (run fully settled)",
            sessionEventTypes.includes("agent_end"),
            `types=[${sessionEventTypes.join(",")}]`,
        );
        check("no session.error push", sessionErrorCount === 0, `count=${sessionErrorCount}`);
        check(
            "assistant text contains 'PONG'",
            assistantText.toUpperCase().includes("PONG"),
            `text=${JSON.stringify(assistantText)}`,
        );

        process.stderr.write(
            `\n[e2e] ${pushEvents.length} push frames, assistantText=${JSON.stringify(assistantText)}\n`,
        );
    } finally {
        await client.dispose();
        // Best-effort cleanup of the sandbox. Force so a leaked sidecar process
        // (shouldn't happen — dispose closes stdin) doesn't block rmSync.
        try {
            rmSync(sandboxRoot, { recursive: true, force: true });
        } catch {
            // ignore — sandbox may have been removed by the OS already
        }
    }

    if (failed > 0) {
        process.stderr.write(`\n[e2e] FAILED: ${failed} assertion(s)\n`);
        return 1;
    }
    process.stderr.write("\n[e2e] PASSED\n");
    return 0;
}

main().then(
    (code) => process.exit(code),
    (e) => {
        process.stderr.write(`[e2e] fatal: ${e?.stack ?? e}\n`);
        process.exit(1);
    },
);
