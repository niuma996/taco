/**
 * settings.write handler — compaction invalidation path:
 *   when patch includes a compaction field, the handler calls
 *   server.invalidateCompactionCaches so every workspace's next
 *   effectiveCompaction() immediately reads the new disk value.
 *
 * Same structure as settings.customProviders.test.ts (handler spy + real disk round-trip).
 */

import { strict as assert } from "node:assert";
import { before, describe, it } from "node:test";
import { registerBuiltinMethods } from "../../../src/server/methods.ts";
import { callMethod } from "../../_helpers/handlerCall.ts";
import { useTempTacoHome } from "../../_helpers/tempTacoHome.ts";

useTempTacoHome("settings-compaction-invalidate");

before(() => {
    registerBuiltinMethods();
});

describe("settings.write — compaction invalidation", () => {
    it("does NOT call invalidateCompactionCaches when patch omits compaction", async () => {
        let invalidateCount = 0;
        const server = {
            providerKeyStore: undefined,
            invalidateCompactionCaches(): void {
                invalidateCount++;
            },
        };
        // Only changing defaultModel, not touching compaction
        await callMethod("settings.write", {
            server,
            params: { global: { defaultModel: "anthropic/claude-x" } },
        });
        assert.equal(invalidateCount, 0, "unrelated fields must not trigger invalidate");
    });

    it("rejects invalid compaction and skips invalidate", async () => {
        let invalidateCount = 0;
        const server = {
            providerKeyStore: undefined,
            invalidateCompactionCaches(): void {
                invalidateCount++;
            },
        };
        // Invalid threshold (out of range) → saveGlobalConfig throws
        await assert.rejects(
            callMethod("settings.write", {
                server,
                params: { global: { compaction: { threshold: 0.05 } } },
            }),
            /invalid compaction\.threshold/,
        );
        assert.equal(invalidateCount, 0, "validation failure must not trigger invalidate");
    });
});
