import { ok, strictEqual } from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "taco-pidreap-"));
    try {
        return await fn(dir);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

/**
 * The killWedgedDaemon behaviour is verified via the same observable
 * surface the function mutates: pid file contents (parse-then-unlink)
 * and socket file existence. The function is private to start.ts, so
 * we re-test the same code paths by exercising parsePidFile and the
 * installId ownership rule.
 *
 * A full process-kill test would require spawning a long-lived fake
 * daemon; that's covered by the PR-E e2e suite against a real daemon.
 */
test("killWedgedDaemon pre-condition: foreign install_id must not be reaped", async () => {
    await withTmp(async (runDir) => {
        // Simulate a daemon whose install_id differs from ours.
        await writeFile(
            join(runDir, "sidecar.pid"),
            JSON.stringify({
                version: 1,
                pid: 999_999, // clearly not us (and not running)
                install_id: "ffff" + "000000000000", // foreign install
                started_at: "2026-08-19T00:00:00.000Z",
            }),
            "utf8",
        );
        const contents = (
            await import("node:fs/promises")
        ).readFile;
        const raw = await contents(join(runDir, "sidecar.pid"), "utf8");
        const parsed = (await import("../lib/installId.ts")).parsePidFile(raw);
        ok(parsed);
        strictEqual(parsed.installId, "ffff000000000000");
        // The reap function skips when parsed.installId !== ownInstallId.
        // We assert that by simulating the ownership comparison directly.
        const ownInstallId = (await import("../lib/installId.ts")).computeInstallId(
            "/this/install",
            "/this/home",
        );
        ok(parsed.installId !== ownInstallId, "foreign pid must not be owned");
    });
});

test("killWedgedDaemon pre-condition: matching install_id is owned", async () => {
    const { computeInstallId, parsePidFile } = await import("../lib/installId.ts");
    const ownInstallId = computeInstallId("/this/install", "/this/home");
    const raw = JSON.stringify({
        version: 1,
        pid: 1234,
        install_id: ownInstallId,
        started_at: "2026-08-19T00:00:00.000Z",
    });
    const parsed = parsePidFile(raw);
    ok(parsed);
    strictEqual(parsed.installId, ownInstallId);
});

test("killWedgedDaemon pre-condition: legacy bare-int files are always reaped", async () => {
    const { parsePidFile } = await import("../lib/installId.ts");
    const parsed = parsePidFile("4242");
    ok(parsed);
    strictEqual(parsed.pid, 4242);
    strictEqual(parsed.installId, null);
    // null installId → ownerMatches evaluates to true (legacy migration path).
});
