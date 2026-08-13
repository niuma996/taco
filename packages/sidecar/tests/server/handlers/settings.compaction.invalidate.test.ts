/**
 * settings.write handler — compaction invalidation path:
 *   when patch includes a compaction field, the handler calls
 *   server.invalidateCompactionCaches so every workspace's next
 *   effectiveCompaction() immediately reads the new disk value.
 *
 * Same structure as settings.customProviders.test.ts (handler spy + real disk round-trip).
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { readGlobalConfig } from "../../../src/config/config.ts";
import { getRegisteredMethod } from "../../../src/server/methodRegistry.ts";
import { registerBuiltinMethods } from "../../../src/server/methods.ts";

let tmpDir: string;
let prevTacoHome: string | undefined;

before(() => {
    prevTacoHome = process.env.TACO_HOME;
    tmpDir = mkdtempSync(join(tmpdir(), "taco-settings-compaction-invalidate-"));
    process.env.TACO_HOME = tmpDir;
    registerBuiltinMethods();
});

after(() => {
    if (prevTacoHome === undefined) {
        Reflect.deleteProperty(process.env, "TACO_HOME");
    } else {
        process.env.TACO_HOME = prevTacoHome;
    }
    rmSync(tmpDir, { recursive: true, force: true });
});

describe("settings.write — compaction invalidation", () => {
    it("calls server.invalidateCompactionCaches when patch has compaction", async () => {
        const reg = getRegisteredMethod("settings.write");
        assert.ok(reg);

        let invalidateCount = 0;
        const server = {
            providerKeyStore: undefined,
            invalidateCompactionCaches(): void {
                invalidateCount++;
            },
        };
        const ctx = {
            id: "test",
            workspace: undefined as never,
            cwd: undefined as never,
            server,
            params: { global: { compaction: { threshold: 0.15 } } },
        } as unknown as Parameters<
            NonNullable<ReturnType<typeof getRegisteredMethod>>["handler"]
        >[0];

        await reg.handler(ctx);

        // Disk persisted
        assert.equal(readGlobalConfig().compaction?.threshold, 0.15);
        // server received invalidate notification
        assert.equal(invalidateCount, 1);
    });

    it("does NOT call invalidateCompactionCaches when patch omits compaction", async () => {
        const reg = getRegisteredMethod("settings.write");
        assert.ok(reg);

        let invalidateCount = 0;
        const server = {
            providerKeyStore: undefined,
            invalidateCompactionCaches(): void {
                invalidateCount++;
            },
        };
        const ctx = {
            id: "test",
            workspace: undefined as never,
            cwd: undefined as never,
            server,
            // Only changing defaultModel, not touching compaction
            params: { global: { defaultModel: "anthropic/claude-x" } },
        } as unknown as Parameters<
            NonNullable<ReturnType<typeof getRegisteredMethod>>["handler"]
        >[0];

        await reg.handler(ctx);
        assert.equal(invalidateCount, 0, "unrelated fields must not trigger invalidate");
    });

    it("rejects invalid compaction and skips invalidate", async () => {
        const reg = getRegisteredMethod("settings.write");
        assert.ok(reg);

        let invalidateCount = 0;
        const server = {
            providerKeyStore: undefined,
            invalidateCompactionCaches(): void {
                invalidateCount++;
            },
        };
        const ctx = {
            id: "test",
            workspace: undefined as never,
            cwd: undefined as never,
            server,
            // Invalid threshold (out of range) → saveGlobalConfig throws
            params: { global: { compaction: { threshold: 0.05 } } },
        } as unknown as Parameters<
            NonNullable<ReturnType<typeof getRegisteredMethod>>["handler"]
        >[0];

        await assert.rejects(reg.handler(ctx), /invalid compaction\.threshold/);
        assert.equal(invalidateCount, 0, "validation failure must not trigger invalidate");
    });
});
